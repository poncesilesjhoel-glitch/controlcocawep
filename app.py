# -*- coding: utf-8 -*-
"""
Sistema de Control de Comercialización de la Hoja de Coca
Proyecto académico (Bolivia) - servidor local con biblioteca estándar de Python.

Ejecutar:  python app.py      (o  py app.py  en Windows)
Abrir:     http://localhost:8000
"""
import csv
import io
import json
import os
import random
import re
import sqlite3
import sys
import threading
from datetime import date, datetime, timedelta, timezone
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, unquote, urlparse

# ---------------------------------------------------------------------------
# Configuración
# ---------------------------------------------------------------------------
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
STATIC_DIR = os.path.join(BASE_DIR, "static")
DB_PATH = os.path.join(BASE_DIR, "control.db")
# En Render (u otro servidor) se usa la variable PORT y se escucha en todas las interfaces.
HOST = "0.0.0.0" if os.environ.get("PORT") else "127.0.0.1"
PORT = int(os.environ.get("PORT", "8000"))
ZONA_BOLIVIA = timezone(timedelta(hours=-4))  # Bolivia: UTC-4, sin horario de verano

LIBRAS_POR_TAQUE = 50          # valor referencial: 1 taque = 50 libras
TOLERANCIA_PESO = 0.20         # avisar si el peso supera en más de 20 % lo esperado

MERCADOS = {
    "Villa Fátima (La Paz)": ["Nor Yungas", "Sud Yungas", "Caranavi", "Inquisivi",
                              "Franz Tamayo (Apolo)", "Otra"],
    "Sacaba (Cochabamba)": ["Chapare", "Carrasco", "Tiraque", "Otra"],
}
DEPARTAMENTOS = ["La Paz", "Cochabamba", "Santa Cruz", "Oruro", "Potosí",
                 "Chuquisaca", "Tarija", "Beni", "Pando"]

RE_CI = re.compile(r"^\d{5,10}(-[0-9A-Za-z]{1,3})?$")
RE_FECHA = re.compile(r"^\d{4}-\d{2}-\d{2}$")

LOCK = threading.Lock()  # serializa las escrituras (servidor multihilo)


def hoy_bolivia():
    """Fecha actual en Bolivia (el servidor en la nube suele estar en UTC)."""
    return datetime.now(ZONA_BOLIVIA).date()

# ---------------------------------------------------------------------------
# Base de datos
# ---------------------------------------------------------------------------
ESQUEMA = """
CREATE TABLE IF NOT EXISTS entradas (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    fecha       TEXT NOT NULL,
    mercado     TEXT NOT NULL,
    productor   TEXT NOT NULL,
    ci          TEXT NOT NULL,
    procedencia TEXT NOT NULL,
    taques      REAL NOT NULL,
    libras      REAL NOT NULL,
    observacion TEXT DEFAULT ''
);
CREATE TABLE IF NOT EXISTS ventas (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    fecha        TEXT NOT NULL,
    entrada_id   INTEGER NOT NULL REFERENCES entradas(id),
    comprador    TEXT NOT NULL,
    ci_comprador TEXT NOT NULL,
    libras       REAL NOT NULL,
    precio_libra REAL NOT NULL,
    total        REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS salidas (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    fecha        TEXT NOT NULL,
    venta_id     INTEGER NOT NULL REFERENCES ventas(id),
    departamento TEXT NOT NULL,
    libras       REAL NOT NULL,
    hoja_ruta    TEXT NOT NULL UNIQUE,
    placa        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_ventas_entrada ON ventas(entrada_id);
CREATE INDEX IF NOT EXISTS ix_salidas_venta  ON salidas(venta_id);
CREATE INDEX IF NOT EXISTS ix_entradas_fecha ON entradas(fecha);
"""


def conectar():
    con = sqlite3.connect(DB_PATH, timeout=15)
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA foreign_keys = ON")
    return con


def iniciar_bd():
    nueva = not os.path.exists(DB_PATH)
    con = conectar()
    con.executescript(ESQUEMA)
    con.commit()
    if nueva:
        print("Creando base de datos con 60 días de datos de ejemplo...")
        generar_datos_ejemplo(con)
    con.close()


def siguiente_hoja_ruta(con, anio):
    prefijo = "HR-%d-" % anio
    fila = con.execute(
        "SELECT hoja_ruta FROM salidas WHERE hoja_ruta LIKE ? ORDER BY hoja_ruta DESC LIMIT 1",
        (prefijo + "%",)).fetchone()
    n = int(fila[0].split("-")[-1]) + 1 if fila else 1
    return "%s%06d" % (prefijo, n)


def saldo_entrada(con, entrada_id):
    f = con.execute("""SELECT e.libras - COALESCE((SELECT SUM(libras) FROM ventas WHERE entrada_id = e.id), 0)
                       FROM entradas e WHERE e.id = ?""", (entrada_id,)).fetchone()
    return None if f is None else round(f[0], 2)


def saldo_venta(con, venta_id):
    f = con.execute("""SELECT v.libras - COALESCE((SELECT SUM(libras) FROM salidas WHERE venta_id = v.id), 0)
                       FROM ventas v WHERE v.id = ?""", (venta_id,)).fetchone()
    return None if f is None else round(f[0], 2)


# ---------------------------------------------------------------------------
# Datos de ejemplo (ficticios)
# ---------------------------------------------------------------------------
NOMBRES = ["Juan", "María", "Pedro", "Rosa", "Carlos", "Ana", "Luis", "Elena", "Jorge", "Carmen",
           "Mario", "Sonia", "René", "Julia", "Freddy", "Lidia", "Wilmer", "Gladys", "Edwin", "Norma",
           "Hugo", "Marta", "Félix", "Teresa", "Germán", "Olga", "Rubén", "Silvia", "Víctor", "Nancy",
           "Efraín", "Justina", "Marcelo", "Celia", "Ramiro", "Basilia"]
APELLIDOS = ["Mamani", "Quispe", "Condori", "Choque", "Flores", "Huanca", "Apaza", "Limachi",
             "Ticona", "Callisaya", "Poma", "Yujra", "Vargas", "Rojas", "Gutiérrez", "Chura",
             "Coaquira", "Laura", "Cruz", "Ramos", "Torrez", "Alanoca", "Patzi", "Calle", "Nina",
             "Colque", "Villca", "Zenteno"]
PESO_PROCEDENCIA = {
    "Villa Fátima (La Paz)": [35, 33, 13, 8, 5, 6],
    "Sacaba (Cochabamba)": [55, 22, 14, 9],
}
PESO_DEPTO = {"Santa Cruz": 39, "Tarija": 17, "Cochabamba": 12, "Oruro": 8, "Potosí": 7,
              "Chuquisaca": 6, "La Paz": 6, "Beni": 4, "Pando": 1}


def _persona(rnd):
    nombre = "%s %s %s" % (rnd.choice(NOMBRES), rnd.choice(APELLIDOS), rnd.choice(APELLIDOS))
    ci = str(rnd.randint(2000000, 13999999))
    if rnd.random() < 0.15:
        ci += "-" + rnd.choice(["1A", "1B", "2C", "1K", "LP"])
    return nombre, ci


def _partir(total, partes, rnd):
    """Divide 'total' libras en 'partes' trozos (múltiplos de 0,5) que suman exactamente total."""
    if partes <= 1 or total < 20 * partes:
        return [round(total, 2)]
    pesos = [rnd.uniform(0.6, 1.4) for _ in range(partes)]
    s = sum(pesos)
    trozos = [round(total * p / s * 2) / 2 for p in pesos[:-1]]
    trozos.append(round(total - sum(trozos), 2))
    return [t for t in trozos if t > 0]


def generar_datos_ejemplo(con):
    rnd = random.Random(2026)
    hoy = hoy_bolivia()
    deptos = list(PESO_DEPTO.keys())
    pesos_depto = list(PESO_DEPTO.values())

    productores = []
    for _ in range(140):
        mercado = "Villa Fátima (La Paz)" if rnd.random() < 0.88 else "Sacaba (Cochabamba)"
        proc = rnd.choices(MERCADOS[mercado], PESO_PROCEDENCIA[mercado])[0]
        nombre, ci = _persona(rnd)
        productores.append((mercado, proc, nombre, ci))
    prod_vf = [p for p in productores if p[0].startswith("Villa")]
    prod_sa = [p for p in productores if p[0].startswith("Sacaba")]
    compradores = [_persona(rnd) for _ in range(45)]
    obs = ["", "", "", "", "", "Hoja seca de buena calidad", "Llegó con lluvia, hoja húmeda",
           "Taques con amarre irregular", "Primera vez en el mercado", "Control rutinario sin novedad"]

    # 1) Entradas
    entradas = []  # (id, fecha, libras, dias_atras)
    for d in range(59, -1, -1):
        f = hoy - timedelta(days=d)
        for _ in range(rnd.randint(4, 8)):
            p = rnd.choice(prod_vf if rnd.random() < 0.88 else prod_sa)
            taques = rnd.choices([1, 2, 3, 4, 5, 6, 8, 10, 12], [5, 12, 16, 18, 16, 13, 10, 6, 4])[0]
            libras = round(taques * LIBRAS_POR_TAQUE * rnd.uniform(0.95, 1.07) * 2) / 2
            cur = con.execute(
                "INSERT INTO entradas (fecha, mercado, productor, ci, procedencia, taques, libras, observacion)"
                " VALUES (?,?,?,?,?,?,?,?)",
                (f.isoformat(), p[0], p[2], p[3], p[1], taques, libras, rnd.choice(obs)))
            entradas.append((cur.lastrowid, f, libras, d, p[0]))

    # 2) Ventas
    ventas = []
    for eid, f, libras, d, mercado in entradas:
        if d >= 4:
            vender = libras
        elif d >= 1:
            vender = libras if rnd.random() < 0.4 else libras * rnd.uniform(0.3, 0.9)
        else:
            vender = libras * rnd.uniform(0.2, 0.6) if rnd.random() < 0.5 else 0
        vender = round(vender * 2) / 2 if vender < libras else libras
        if vender <= 0:
            continue
        for trozo in _partir(vender, rnd.choice([1, 1, 2, 2, 3]), rnd):
            fv = min(f + timedelta(days=rnd.choice([0, 0, 0, 1])), hoy)
            precio = round(rnd.uniform(35, 45) * 2) / 2
            comp = rnd.choice(compradores)
            ventas.append([fv, eid, comp[0], comp[1], trozo, precio])
    ventas.sort(key=lambda v: (v[0], v[1]))
    ventas_ins = []
    for fv, eid, comp, ci, lb, precio in ventas:
        cur = con.execute(
            "INSERT INTO ventas (fecha, entrada_id, comprador, ci_comprador, libras, precio_libra, total)"
            " VALUES (?,?,?,?,?,?,?)",
            (fv.isoformat(), eid, comp, ci, lb, precio, round(lb * precio, 2)))
        ventas_ins.append((cur.lastrowid, fv, lb))

    # 3) Salidas
    salidas = []
    for vid, fv, lb in ventas_ins:
        dv = (hoy - fv).days
        if dv >= 3:
            despachar = lb
        elif dv >= 1:
            despachar = lb if rnd.random() < 0.6 else (lb * rnd.uniform(0.4, 0.8) if rnd.random() < 0.6 else 0)
        else:
            despachar = lb * rnd.uniform(0.3, 0.7) if rnd.random() < 0.3 else 0
        despachar = round(despachar * 2) / 2 if despachar < lb else lb
        if despachar <= 0:
            continue
        depto = rnd.choices(deptos, pesos_depto)[0]
        for trozo in _partir(despachar, 2 if rnd.random() < 0.2 else 1, rnd):
            fs = min(fv + timedelta(days=rnd.choice([0, 0, 1])), hoy)
            if rnd.random() < 0.1:
                depto = rnd.choices(deptos, pesos_depto)[0]
            placa = "%d-%s" % (rnd.randint(1000, 5999), "".join(rnd.choice("BCDFGHJKLMNPRSTVWXYZ") for _ in range(3)))
            salidas.append((fs, vid, depto, trozo, placa))
    salidas.sort(key=lambda s: (s[0], s[1]))
    for fs, vid, depto, lb, placa in salidas:
        codigo = siguiente_hoja_ruta(con, fs.year)
        con.execute(
            "INSERT INTO salidas (fecha, venta_id, departamento, libras, hoja_ruta, placa) VALUES (?,?,?,?,?,?)",
            (fs.isoformat(), vid, depto, lb, codigo, placa))
    con.commit()
    print("  %d entradas, %d ventas, %d salidas generadas." % (len(entradas), len(ventas_ins), len(salidas)))


# ---------------------------------------------------------------------------
# Validación
# ---------------------------------------------------------------------------
def _texto(datos, campo):
    v = datos.get(campo)
    return "" if v is None else str(v).strip()


def _numero(datos, campo, nombre, errores):
    v = datos.get(campo)
    if v is None or str(v).strip() == "":
        errores.append("El campo «%s» es obligatorio." % nombre)
        return None
    try:
        n = float(str(v).replace(",", "."))
    except ValueError:
        errores.append("«%s» debe ser un número." % nombre)
        return None
    if n <= 0:
        errores.append("«%s» debe ser mayor que 0." % nombre)
        return None
    return round(n, 2)


def _fecha(datos, errores):
    f = _texto(datos, "fecha") or hoy_bolivia().isoformat()
    if not RE_FECHA.match(f):
        errores.append("La fecha debe tener el formato AAAA-MM-DD.")
        return None
    try:
        d = datetime.strptime(f, "%Y-%m-%d").date()
    except ValueError:
        errores.append("La fecha no es válida.")
        return None
    if d > hoy_bolivia():
        errores.append("La fecha no puede ser posterior a hoy.")
        return None
    return f


def _obligatorio(datos, campo, nombre, errores):
    v = _texto(datos, campo)
    if not v:
        errores.append("El campo «%s» es obligatorio." % nombre)
    return v


def _ci(datos, campo, nombre, errores):
    v = _texto(datos, campo).upper()
    if not v:
        errores.append("El campo «%s» es obligatorio." % nombre)
    elif not RE_CI.match(v):
        errores.append("%s inválido: debe tener de 5 a 10 dígitos, con complemento opcional (ej. 1234567-1A)." % nombre)
    return v


def crear_entrada(datos):
    errores, avisos = [], []
    fecha = _fecha(datos, errores)
    mercado = _obligatorio(datos, "mercado", "Mercado", errores)
    if mercado and mercado not in MERCADOS:
        errores.append("El mercado «%s» no está autorizado." % mercado)
    procedencia = _obligatorio(datos, "procedencia", "Procedencia", errores)
    if mercado in MERCADOS and procedencia and procedencia not in MERCADOS[mercado]:
        errores.append("La procedencia «%s» no corresponde al mercado %s." % (procedencia, mercado))
    productor = _obligatorio(datos, "productor", "Productor", errores)
    ci = _ci(datos, "ci", "CI del productor", errores)
    taques = _numero(datos, "taques", "Taques", errores)
    libras = _numero(datos, "libras", "Libras", errores)
    observacion = _texto(datos, "observacion")[:500]
    if taques and libras:
        esperado = taques * LIBRAS_POR_TAQUE
        if libras > esperado * (1 + TOLERANCIA_PESO):
            avisos.append("Atención: %s lb supera en más del 20%% lo esperado para %s taques (%s lb)."
                          % (_n(libras), _n(taques), _n(esperado)))
    if errores:
        return 400, {"errores": errores}
    with LOCK:
        con = conectar()
        cur = con.execute(
            "INSERT INTO entradas (fecha, mercado, productor, ci, procedencia, taques, libras, observacion)"
            " VALUES (?,?,?,?,?,?,?,?)",
            (fecha, mercado, productor, ci, procedencia, taques, libras, observacion))
        con.commit()
        nid = cur.lastrowid
        con.close()
    return 201, {"ok": True, "id": nid, "avisos": avisos, "mensaje": "Entrada Nº %d registrada." % nid}


def crear_venta(datos):
    errores = []
    fecha = _fecha(datos, errores)
    entrada_id = _texto(datos, "entrada_id")
    if not entrada_id:
        errores.append("Debe elegir la entrada (lote) que se vende.")
    elif not entrada_id.isdigit():
        errores.append("La entrada elegida no es válida.")
    comprador = _obligatorio(datos, "comprador", "Comprador", errores)
    ci = _ci(datos, "ci_comprador", "CI del comprador", errores)
    libras = _numero(datos, "libras", "Libras", errores)
    precio = _numero(datos, "precio_libra", "Precio por libra", errores)
    if errores:
        return 400, {"errores": errores}
    with LOCK:
        con = conectar()
        try:
            ent = con.execute("SELECT * FROM entradas WHERE id = ?", (int(entrada_id),)).fetchone()
            if ent is None:
                return 400, {"errores": ["La entrada Nº %s no existe." % entrada_id]}
            if fecha < ent["fecha"]:
                errores.append("La fecha de venta no puede ser anterior a la fecha de entrada (%s)." % ent["fecha"])
            saldo = saldo_entrada(con, ent["id"])
            if libras > saldo + 1e-9:
                errores.append("La venta (%s lb) supera lo que queda sin vender de la entrada Nº %d (%s lb)."
                               % (_n(libras), ent["id"], _n(saldo)))
            if errores:
                return 400, {"errores": errores}
            total = round(libras * precio, 2)
            cur = con.execute(
                "INSERT INTO ventas (fecha, entrada_id, comprador, ci_comprador, libras, precio_libra, total)"
                " VALUES (?,?,?,?,?,?,?)", (fecha, ent["id"], comprador, ci, libras, precio, total))
            con.commit()
            return 201, {"ok": True, "id": cur.lastrowid, "total": total, "avisos": [],
                         "mensaje": "Venta Nº %d registrada." % cur.lastrowid}
        finally:
            con.close()


def crear_salida(datos):
    errores = []
    fecha = _fecha(datos, errores)
    venta_id = _texto(datos, "venta_id")
    if not venta_id:
        errores.append("Debe elegir la venta que se despacha.")
    elif not venta_id.isdigit():
        errores.append("La venta elegida no es válida.")
    departamento = _obligatorio(datos, "departamento", "Departamento destino", errores)
    if departamento and departamento not in DEPARTAMENTOS:
        errores.append("El departamento «%s» no es válido." % departamento)
    libras = _numero(datos, "libras", "Libras", errores)
    placa = _obligatorio(datos, "placa", "Placa del vehículo", errores).upper()
    if placa and not re.match(r"^[0-9A-Z][0-9A-Z\- ]{3,11}$", placa):
        errores.append("La placa no es válida (ej. 2345-KTR).")
    if errores:
        return 400, {"errores": errores}
    with LOCK:
        con = conectar()
        try:
            ven = con.execute("SELECT * FROM ventas WHERE id = ?", (int(venta_id),)).fetchone()
            if ven is None:
                return 400, {"errores": ["La venta Nº %s no existe." % venta_id]}
            if fecha < ven["fecha"]:
                errores.append("La fecha de salida no puede ser anterior a la fecha de venta (%s)." % ven["fecha"])
            saldo = saldo_venta(con, ven["id"])
            if libras > saldo + 1e-9:
                errores.append("La salida (%s lb) supera lo vendido que aún no salió de la venta Nº %d (%s lb)."
                               % (_n(libras), ven["id"], _n(saldo)))
            if errores:
                return 400, {"errores": errores}
            codigo = siguiente_hoja_ruta(con, int(fecha[:4]))
            cur = con.execute(
                "INSERT INTO salidas (fecha, venta_id, departamento, libras, hoja_ruta, placa) VALUES (?,?,?,?,?,?)",
                (fecha, ven["id"], departamento, libras, codigo, placa))
            con.commit()
            return 201, {"ok": True, "id": cur.lastrowid, "hoja_ruta": codigo, "avisos": [],
                         "mensaje": "Salida registrada con hoja de ruta %s." % codigo}
        finally:
            con.close()


def _n(x):
    """Formato boliviano simple para mensajes: 1.250,5"""
    s = ("%.2f" % x).rstrip("0").rstrip(".")
    ent, _, dec = s.partition(".")
    neg = ent.startswith("-")
    ent = ent.lstrip("-")
    grupos = []
    while len(ent) > 3:
        grupos.insert(0, ent[-3:])
        ent = ent[:-3]
    grupos.insert(0, ent)
    return ("-" if neg else "") + ".".join(grupos) + ("," + dec if dec else "")


# ---------------------------------------------------------------------------
# Consultas
# ---------------------------------------------------------------------------
SQL_ENTRADAS = """
SELECT * FROM (
  SELECT e.*, ROUND(e.libras - COALESCE((SELECT SUM(v.libras) FROM ventas v WHERE v.entrada_id = e.id), 0), 2) AS saldo
  FROM entradas e
) t
"""
SQL_VENTAS = """
SELECT * FROM (
  SELECT v.*, e.mercado, e.procedencia, e.productor, e.fecha AS fecha_entrada,
         ROUND(v.libras - COALESCE((SELECT SUM(s.libras) FROM salidas s WHERE s.venta_id = v.id), 0), 2) AS saldo
  FROM ventas v JOIN entradas e ON e.id = v.entrada_id
) t
"""
SQL_SALIDAS = """
SELECT s.*, v.comprador, v.ci_comprador, v.fecha AS fecha_venta, v.precio_libra,
       e.id AS entrada_id, e.mercado, e.procedencia, e.productor, e.ci AS ci_productor, e.fecha AS fecha_entrada
FROM salidas s JOIN ventas v ON v.id = s.venta_id JOIN entradas e ON e.id = v.entrada_id
"""


def _filas(cur):
    return [dict(r) for r in cur.fetchall()]


def listar_entradas(qs):
    cond, par = [], []
    q = qs.get("q", "").strip()
    if q:
        cond.append("(productor LIKE ? OR ci LIKE ? OR procedencia LIKE ? OR mercado LIKE ? OR CAST(id AS TEXT) = ?)")
        par += ["%" + q + "%"] * 4 + [q.lstrip("#")]
    if qs.get("con_saldo") == "1":
        cond.append("saldo > 0.004")
    if qs.get("mercado"):
        cond.append("mercado = ?")
        par.append(qs["mercado"])
    sql = SQL_ENTRADAS + (" WHERE " + " AND ".join(cond) if cond else "") + " ORDER BY fecha DESC, id DESC LIMIT 500"
    con = conectar()
    try:
        return _filas(con.execute(sql, par))
    finally:
        con.close()


def listar_ventas(qs):
    cond, par = [], []
    q = qs.get("q", "").strip()
    if q:
        cond.append("(comprador LIKE ? OR ci_comprador LIKE ? OR productor LIKE ? OR procedencia LIKE ?"
                    " OR CAST(id AS TEXT) = ?)")
        par += ["%" + q + "%"] * 4 + [q.lstrip("#")]
    if qs.get("con_saldo") == "1":
        cond.append("saldo > 0.004")
    sql = SQL_VENTAS + (" WHERE " + " AND ".join(cond) if cond else "") + " ORDER BY fecha DESC, id DESC LIMIT 500"
    con = conectar()
    try:
        return _filas(con.execute(sql, par))
    finally:
        con.close()


def listar_salidas(qs, limite=500):
    cond, par = [], []
    if qs.get("departamento"):
        cond.append("s.departamento = ?")
        par.append(qs["departamento"])
    q = qs.get("q", "").strip()
    if q:
        cond.append("(s.hoja_ruta LIKE ? OR s.placa LIKE ? OR v.comprador LIKE ?)")
        par += ["%" + q + "%"] * 3
    c2, p2 = _filtros_fecha_mercado(qs, "s.fecha")
    cond += c2
    par += p2
    sql = SQL_SALIDAS + (" WHERE " + " AND ".join(cond) if cond else "") + " ORDER BY s.fecha DESC, s.id DESC"
    if limite:
        sql += " LIMIT %d" % limite
    con = conectar()
    try:
        return _filas(con.execute(sql, par))
    finally:
        con.close()


def hoja_ruta(codigo):
    con = conectar()
    try:
        f = con.execute(SQL_SALIDAS + " WHERE s.hoja_ruta = ?", (codigo.strip().upper(),)).fetchone()
        return dict(f) if f else None
    finally:
        con.close()


def _filtros_fecha_mercado(qs, col_fecha):
    cond, par = [], []
    if qs.get("desde") and RE_FECHA.match(qs["desde"]):
        cond.append(col_fecha + " >= ?")
        par.append(qs["desde"])
    if qs.get("hasta") and RE_FECHA.match(qs["hasta"]):
        cond.append(col_fecha + " <= ?")
        par.append(qs["hasta"])
    if qs.get("mercado"):
        cond.append("e.mercado = ?")
        par.append(qs["mercado"])
    return cond, par


def _where(cond):
    return (" WHERE " + " AND ".join(cond)) if cond else ""


def resumen(qs):
    con = conectar()
    try:
        ce, pe = _filtros_fecha_mercado(qs, "e.fecha")
        cv, pv = _filtros_fecha_mercado(qs, "v.fecha")
        cs, ps = _filtros_fecha_mercado(qs, "s.fecha")
        FROM_V = " FROM ventas v JOIN entradas e ON e.id = v.entrada_id"
        FROM_S = " FROM salidas s JOIN ventas v ON v.id = s.venta_id JOIN entradas e ON e.id = v.entrada_id"

        r = con.execute("SELECT COUNT(*), COALESCE(SUM(libras),0), COALESCE(SUM(taques),0) FROM entradas e"
                        + _where(ce), pe).fetchone()
        entradas = {"cantidad": r[0], "libras": round(r[1], 2), "taques": round(r[2], 2)}
        r = con.execute("SELECT COUNT(*), COALESCE(SUM(v.libras),0), COALESCE(SUM(v.total),0)" + FROM_V
                        + _where(cv), pv).fetchone()
        ventas = {"cantidad": r[0], "libras": round(r[1], 2), "monto": round(r[2], 2)}
        r = con.execute("SELECT COUNT(*), COALESCE(SUM(s.libras),0)" + FROM_S + _where(cs), ps).fetchone()
        salidas = {"cantidad": r[0], "libras": round(r[1], 2), "hojas_ruta": r[0]}
        precio_promedio = round(ventas["monto"] / ventas["libras"], 2) if ventas["libras"] else 0

        # Inventario actual (no depende de las fechas, solo del mercado)
        cm, pm = ([" WHERE mercado = ?"], [qs["mercado"]]) if qs.get("mercado") else ([""], [])
        sin_vender = con.execute("SELECT COALESCE(SUM(saldo),0) FROM (" + SQL_ENTRADAS + cm[0] + ")", pm).fetchone()[0]
        sin_salir = con.execute("SELECT COALESCE(SUM(saldo),0) FROM (" + SQL_VENTAS + cm[0] + ")", pm).fetchone()[0]
        inventario = {"sin_vender": round(sin_vender, 2), "vendida_sin_salir": round(sin_salir, 2),
                      "total_en_mercado": round(sin_vender + sin_salir, 2),
                      "taques_equivalentes": round((sin_vender + sin_salir) / LIBRAS_POR_TAQUE, 1)}

        # Por departamento
        datos = {row[0]: (row[1], row[2]) for row in con.execute(
            "SELECT s.departamento, SUM(s.libras), COUNT(*)" + FROM_S + _where(cs) + " GROUP BY s.departamento", ps)}
        total_s = sum(v[0] for v in datos.values()) or 0
        por_departamento = []
        for d in DEPARTAMENTOS:
            lb, n = datos.get(d, (0, 0))
            por_departamento.append({"departamento": d, "libras": round(lb, 2), "hojas_ruta": n,
                                     "porcentaje": round(lb * 100 / total_s, 2) if total_s else 0})
        por_departamento.sort(key=lambda x: -x["libras"])

        # Por procedencia
        filas = con.execute("SELECT e.mercado, e.procedencia, COUNT(*), SUM(e.libras), SUM(e.taques) FROM entradas e"
                            + _where(ce) + " GROUP BY e.mercado, e.procedencia ORDER BY SUM(e.libras) DESC", pe).fetchall()
        por_procedencia = [{"mercado": f[0], "procedencia": f[1], "entradas": f[2], "libras": round(f[3], 2),
                            "taques": round(f[4], 2),
                            "porcentaje": round(f[3] * 100 / entradas["libras"], 2) if entradas["libras"] else 0}
                           for f in filas]

        # Por mes
        meses = {}
        for f in con.execute("SELECT substr(e.fecha,1,7), SUM(e.libras), COUNT(*) FROM entradas e" + _where(ce)
                             + " GROUP BY 1", pe):
            meses.setdefault(f[0], {})["entradas_lb"] = round(f[1], 2)
            meses[f[0]]["entradas_n"] = f[2]
        for f in con.execute("SELECT substr(v.fecha,1,7), SUM(v.libras), SUM(v.total)" + FROM_V + _where(cv)
                             + " GROUP BY 1", pv):
            meses.setdefault(f[0], {})["ventas_lb"] = round(f[1], 2)
            meses[f[0]]["monto"] = round(f[2], 2)
        for f in con.execute("SELECT substr(s.fecha,1,7), SUM(s.libras), COUNT(*)" + FROM_S + _where(cs)
                             + " GROUP BY 1", ps):
            meses.setdefault(f[0], {})["salidas_lb"] = round(f[1], 2)
            meses[f[0]]["hojas_ruta"] = f[2]
        por_mes = []
        for m in sorted(meses):
            d = meses[m]
            por_mes.append({"mes": m, "entradas_lb": d.get("entradas_lb", 0), "entradas_n": d.get("entradas_n", 0),
                            "ventas_lb": d.get("ventas_lb", 0), "monto": d.get("monto", 0),
                            "salidas_lb": d.get("salidas_lb", 0), "hojas_ruta": d.get("hojas_ruta", 0)})

        # Por día (últimos 30 días hasta 'hasta' o hoy)
        try:
            fin = datetime.strptime(qs.get("hasta", ""), "%Y-%m-%d").date()
        except ValueError:
            fin = hoy_bolivia()
        ini = fin - timedelta(days=29)
        cd, pd = ["e.fecha >= ?", "e.fecha <= ?"], [ini.isoformat(), fin.isoformat()]
        if qs.get("mercado"):
            cd.append("e.mercado = ?")
            pd.append(qs["mercado"])
        dias = {f[0]: (f[1], f[2]) for f in con.execute(
            "SELECT e.fecha, SUM(e.libras), COUNT(*) FROM entradas e" + _where(cd) + " GROUP BY e.fecha", pd)}
        por_dia = []
        for i in range(30):
            d = (ini + timedelta(days=i)).isoformat()
            lb, n = dias.get(d, (0, 0))
            por_dia.append({"fecha": d, "libras": round(lb, 2), "entradas": n})

        return {"filtros": {k: qs.get(k, "") for k in ("desde", "hasta", "mercado")},
                "entradas": entradas, "ventas": ventas, "salidas": salidas,
                "precio_promedio": precio_promedio, "inventario": inventario,
                "por_departamento": por_departamento, "por_procedencia": por_procedencia,
                "por_mes": por_mes, "por_dia": por_dia}
    finally:
        con.close()


def _dec(x):
    return ("%.2f" % x).replace(".", ",")


def csv_departamentos(qs):
    r = resumen(qs)
    buf = io.StringIO()
    w = csv.writer(buf, delimiter=";", lineterminator="\r\n")
    w.writerow(["Departamento", "Libras", "Taques equivalentes", "Hojas de ruta", "Porcentaje (%)"])
    for d in r["por_departamento"]:
        w.writerow([d["departamento"], _dec(d["libras"]), _dec(d["libras"] / LIBRAS_POR_TAQUE),
                    d["hojas_ruta"], _dec(d["porcentaje"])])
    w.writerow(["TOTAL", _dec(r["salidas"]["libras"]), _dec(r["salidas"]["libras"] / LIBRAS_POR_TAQUE),
                r["salidas"]["hojas_ruta"], _dec(100 if r["salidas"]["libras"] else 0)])
    return buf.getvalue()


def csv_salidas(qs):
    buf = io.StringIO()
    w = csv.writer(buf, delimiter=";", lineterminator="\r\n")
    w.writerow(["Hoja de ruta", "Fecha salida", "Departamento", "Libras", "Placa", "Comprador", "CI comprador",
                "Nº venta", "Mercado", "Procedencia", "Productor", "Nº entrada"])
    for s in listar_salidas(qs, limite=0):
        w.writerow([s["hoja_ruta"], s["fecha"], s["departamento"], _dec(s["libras"]), s["placa"], s["comprador"],
                    s["ci_comprador"], s["venta_id"], s["mercado"], s["procedencia"], s["productor"], s["entrada_id"]])
    return buf.getvalue()


# ---------------------------------------------------------------------------
# Servidor HTTP
# ---------------------------------------------------------------------------
TIPOS = {".html": "text/html; charset=utf-8", ".js": "application/javascript; charset=utf-8",
         ".css": "text/css; charset=utf-8", ".png": "image/png", ".svg": "image/svg+xml",
         ".ico": "image/x-icon", ".txt": "text/plain; charset=utf-8"}


class Manejador(SimpleHTTPRequestHandler):
    server_version = "ControlCoca/1.0"

    def log_message(self, fmt, *args):
        if "/api/" in (self.path or ""):
            sys.stderr.write("%s  %s\n" % (self.log_date_time_string(), fmt % args))

    def _enviar(self, codigo, cuerpo, tipo, extra=None):
        datos = cuerpo.encode("utf-8") if isinstance(cuerpo, str) else cuerpo
        self.send_response(codigo)
        self.send_header("Content-Type", tipo)
        self.send_header("Content-Length", str(len(datos)))
        self.send_header("Cache-Control", "no-store")
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(datos)

    def _json(self, codigo, obj):
        self._enviar(codigo, json.dumps(obj, ensure_ascii=False), "application/json; charset=utf-8")

    def _csv(self, nombre, texto):
        self._enviar(200, "﻿" + texto, "text/csv; charset=utf-8",
                     {"Content-Disposition": 'attachment; filename="%s"' % nombre})

    def do_GET(self):
        url = urlparse(self.path)
        ruta = url.path
        qs = {k: v[0] for k, v in parse_qs(url.query).items()}
        try:
            if ruta.startswith("/api/"):
                return self._api_get(ruta, qs)
            return self._estatico(ruta)
        except Exception as e:  # pragma: no cover
            self._json(500, {"errores": ["Error interno del servidor: %s" % e]})

    def _api_get(self, ruta, qs):
        if ruta == "/api/config":
            return self._json(200, {"mercados": MERCADOS, "departamentos": DEPARTAMENTOS,
                                    "libras_por_taque": LIBRAS_POR_TAQUE, "tolerancia_peso": TOLERANCIA_PESO,
                                    "hoy": hoy_bolivia().isoformat()})
        if ruta == "/api/resumen":
            return self._json(200, resumen(qs))
        if ruta == "/api/entradas":
            return self._json(200, listar_entradas(qs))
        if ruta == "/api/ventas":
            return self._json(200, listar_ventas(qs))
        if ruta == "/api/salidas":
            return self._json(200, listar_salidas(qs))
        if ruta.startswith("/api/hoja-ruta/"):
            codigo = unquote(ruta[len("/api/hoja-ruta/"):])
            hr = hoja_ruta(codigo)
            if hr is None:
                return self._json(404, {"errores": ["La hoja de ruta «%s» no existe." % codigo]})
            return self._json(200, hr)
        if ruta == "/api/exportar/departamentos.csv":
            return self._csv("departamentos.csv", csv_departamentos(qs))
        if ruta == "/api/exportar/salidas.csv":
            return self._csv("salidas.csv", csv_salidas(qs))
        return self._json(404, {"errores": ["Ruta no encontrada."]})

    def do_POST(self):
        ruta = urlparse(self.path).path
        try:
            largo = int(self.headers.get("Content-Length") or 0)
            crudo = self.rfile.read(largo) if largo else b"{}"
            try:
                datos = json.loads(crudo.decode("utf-8") or "{}")
                if not isinstance(datos, dict):
                    raise ValueError
            except ValueError:
                return self._json(400, {"errores": ["El cuerpo de la petición debe ser JSON válido."]})
            acciones = {"/api/entradas": crear_entrada, "/api/ventas": crear_venta, "/api/salidas": crear_salida}
            if ruta not in acciones:
                return self._json(404, {"errores": ["Ruta no encontrada."]})
            codigo, resp = acciones[ruta](datos)
            return self._json(codigo, resp)
        except Exception as e:  # pragma: no cover
            self._json(500, {"errores": ["Error interno del servidor: %s" % e]})

    def _estatico(self, ruta):
        if ruta in ("/", ""):
            ruta = "/index.html"
        destino = os.path.normpath(os.path.join(STATIC_DIR, unquote(ruta).lstrip("/")))
        if not destino.startswith(STATIC_DIR) or not os.path.isfile(destino):
            return self._enviar(404, "No encontrado", "text/plain; charset=utf-8")
        with open(destino, "rb") as f:
            datos = f.read()
        tipo = TIPOS.get(os.path.splitext(destino)[1].lower(), "application/octet-stream")
        self._enviar(200, datos, tipo)


def main():
    puerto = int(sys.argv[1]) if len(sys.argv) > 1 else PORT
    iniciar_bd()
    servidor = ThreadingHTTPServer((HOST, puerto), Manejador)
    print("=" * 60)
    print(" Sistema de Control de Comercialización de la Hoja de Coca")
    print(" Abra en su navegador:  http://localhost:%d" % puerto)
    print(" Presione Ctrl+C para detener el servidor.")
    print("=" * 60)
    try:
        servidor.serve_forever()
    except KeyboardInterrupt:
        print("\nServidor detenido.")
    finally:
        servidor.server_close()


if __name__ == "__main__":
    main()
