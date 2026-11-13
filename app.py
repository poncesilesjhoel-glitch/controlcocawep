# -*- coding: utf-8 -*-
"""
Sistema de Control de Comercialización de la Hoja de Coca
Proyecto académico (Bolivia).

Local:  python app.py   (o  py app.py)  ->  http://localhost:8000   (usa SQLite: control.db)
Nube:   con la variable DATABASE_URL=postgresql://...  usa PostgreSQL (necesita: pip install pg8000)

Variables de entorno opcionales:
  PORT            puerto (Render lo asigna solo)
  DATABASE_URL    conexión PostgreSQL (Neon, Render, etc.). Si no existe se usa SQLite.
  ADMIN_USUARIO   usuario administrador inicial (por defecto: admin)
  ADMIN_CLAVE     contraseña del administrador inicial (local por defecto: admin123)
  DATOS_DEMO      "0" para NO generar datos de ejemplo en una base vacía
"""
import csv
import hashlib
import hmac
import io
import json
import os
import queue
import random
import re
import secrets
import sqlite3
import ssl
import sys
import threading
import time
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, unquote, urlparse

# ---------------------------------------------------------------------------
# Configuración
# ---------------------------------------------------------------------------
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
STATIC_DIR = os.path.join(BASE_DIR, "static")
DB_PATH = os.path.join(BASE_DIR, "control.db")
EN_LA_NUBE = bool(os.environ.get("PORT"))
HOST = "0.0.0.0" if EN_LA_NUBE else "127.0.0.1"
PORT = int(os.environ.get("PORT", "8000"))
DATABASE_URL = os.environ.get("DATABASE_URL", "").strip()
ES_PG = DATABASE_URL.startswith(("postgres://", "postgresql://"))
ZONA_BOLIVIA = timezone(timedelta(hours=-4))  # Bolivia: UTC-4, sin horario de verano

LIBRAS_POR_TAQUE = 50          # valor referencial: 1 taque = 50 libras
TOLERANCIA_PESO = 0.20         # avisar si el peso supera en más de 20 % lo esperado
DURACION_SESION = timedelta(hours=12)

MERCADOS = {
    "Villa Fátima (La Paz)": ["Nor Yungas", "Sud Yungas", "Caranavi", "Inquisivi",
                              "Franz Tamayo (Apolo)", "Otra"],
    "Sacaba (Cochabamba)": ["Chapare", "Carrasco", "Tiraque", "Otra"],
}
DEPARTAMENTOS = ["La Paz", "Cochabamba", "Santa Cruz", "Oruro", "Potosí",
                 "Chuquisaca", "Tarija", "Beni", "Pando"]
ROLES = {"admin": "Administrador", "operador": "Operador"}

RE_CI = re.compile(r"^\d{5,10}(-[0-9A-Za-z]{1,3})?$")
RE_FECHA = re.compile(r"^\d{4}-\d{2}-\d{2}$")
RE_USUARIO = re.compile(r"^[a-z0-9_.]{3,30}$")

LOCK = threading.Lock()  # serializa las escrituras (servidor multihilo)


def hoy_bolivia():
    return datetime.now(ZONA_BOLIVIA).date()


def ahora_utc():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S")


# ---------------------------------------------------------------------------
# Capa de base de datos (SQLite local o PostgreSQL en la nube)
# ---------------------------------------------------------------------------
pg8000 = None
if ES_PG:
    try:
        import pg8000.dbapi as pg8000
    except ImportError:
        sys.exit("Para usar PostgreSQL instale el conector:  pip install pg8000")


def _norm(v):
    return float(v) if isinstance(v, Decimal) else v


class Conexion:
    """Envoltorio mínimo con la misma interfaz para SQLite y PostgreSQL."""

    def __init__(self, con, es_pg):
        self.con, self.pg = con, es_pg

    def _cur(self, sql, p):
        if self.pg:
            sql = sql.replace("%", "%%").replace("?", "%s")
        cur = self.con.cursor()
        cur.execute(sql, tuple(p))
        return cur

    def todos(self, sql, p=()):
        cur = self._cur(sql, p)
        if not cur.description:
            return []
        cols = [d[0] for d in cur.description]
        return [dict(zip(cols, [_norm(v) for v in fila])) for fila in cur.fetchall()]

    def uno(self, sql, p=()):
        f = self.todos(sql, p)
        return f[0] if f else None

    def valor(self, sql, p=()):
        f = self._cur(sql, p).fetchone()
        return _norm(f[0]) if f else None

    def ejecutar(self, sql, p=()):
        self._cur(sql, p)

    def insertar(self, sql, p=()):
        if self.pg:
            return self._cur(sql + " RETURNING id", p).fetchone()[0]
        return self._cur(sql, p).lastrowid

    def lote(self, tabla, cols, filas, tam=200):
        for i in range(0, len(filas), tam):
            parte = filas[i:i + tam]
            marcas = ",".join(["(" + ",".join("?" * len(cols)) + ")"] * len(parte))
            self.ejecutar("INSERT INTO %s (%s) VALUES %s" % (tabla, ",".join(cols), marcas),
                          [v for f in parte for v in f])


def _cerrar(con):
    try:
        con.close()
    except Exception:
        pass


class BaseDatos:
    def __init__(self):
        self.pg = ES_PG
        self.libres = queue.LifoQueue()
        if self.pg:
            u = urlparse(DATABASE_URL)
            self.params = {"user": unquote(u.username or ""), "password": unquote(u.password or ""),
                           "host": u.hostname, "port": u.port or 5432,
                           "database": (u.path or "/").lstrip("/") or "postgres", "timeout": 30}
            if parse_qs(u.query).get("sslmode", ["require"])[0] != "disable":
                self.params["ssl_context"] = ssl.create_default_context()

    def _conectar(self):
        if self.pg:
            return pg8000.connect(**self.params)
        con = sqlite3.connect(DB_PATH, timeout=15, check_same_thread=False)
        con.execute("PRAGMA foreign_keys = ON")
        con.execute("PRAGMA journal_mode = WAL")  # lectores y escritores no se bloquean
        return con

    def _obtener(self):
        while True:
            try:
                con, t = self.libres.get_nowait()
            except queue.Empty:
                return self._conectar()
            if time.time() - t < 30:
                return con
            try:  # conexión inactiva hace rato: comprobar que sigue viva
                cur = con.cursor()
                cur.execute("SELECT 1")
                cur.fetchall()
                con.rollback()
                return con
            except Exception:
                _cerrar(con)

    @contextmanager
    def sesion(self):
        con = self._obtener()
        ok = False
        try:
            yield Conexion(con, self.pg)
            con.commit()
            ok = True
        finally:
            if not ok:
                try:
                    con.rollback()
                except Exception:
                    _cerrar(con)
                    con = None
            if con is not None:
                if self.libres.qsize() < 8:
                    self.libres.put((con, time.time()))
                else:
                    _cerrar(con)


BD = BaseDatos()


def R(expr):
    """Redondeo a 2 decimales compatible con SQLite y PostgreSQL."""
    return "ROUND(CAST(%s AS NUMERIC), 2)" % expr


def LIKE():
    return "ILIKE" if ES_PG else "LIKE"


def esquema():
    ID = "SERIAL PRIMARY KEY" if ES_PG else "INTEGER PRIMARY KEY AUTOINCREMENT"
    N = "DOUBLE PRECISION" if ES_PG else "REAL"
    return [
        """CREATE TABLE IF NOT EXISTS usuarios (
            id %s, usuario TEXT NOT NULL UNIQUE, nombre TEXT NOT NULL, clave TEXT NOT NULL,
            rol TEXT NOT NULL DEFAULT 'operador', activo INTEGER NOT NULL DEFAULT 1, creado TEXT NOT NULL)""" % ID,
        """CREATE TABLE IF NOT EXISTS sesiones (
            token TEXT PRIMARY KEY, usuario_id INTEGER NOT NULL REFERENCES usuarios(id), expira TEXT NOT NULL)""",
        """CREATE TABLE IF NOT EXISTS entradas (
            id %s, fecha TEXT NOT NULL, mercado TEXT NOT NULL, productor TEXT NOT NULL, ci TEXT NOT NULL,
            procedencia TEXT NOT NULL, taques %s NOT NULL, libras %s NOT NULL, observacion TEXT DEFAULT '',
            registrado_por TEXT DEFAULT '')""" % (ID, N, N),
        """CREATE TABLE IF NOT EXISTS ventas (
            id %s, fecha TEXT NOT NULL, entrada_id INTEGER NOT NULL REFERENCES entradas(id),
            comprador TEXT NOT NULL, ci_comprador TEXT NOT NULL, libras %s NOT NULL,
            precio_libra %s NOT NULL, total %s NOT NULL, registrado_por TEXT DEFAULT '')""" % (ID, N, N, N),
        """CREATE TABLE IF NOT EXISTS salidas (
            id %s, fecha TEXT NOT NULL, venta_id INTEGER NOT NULL REFERENCES ventas(id),
            departamento TEXT NOT NULL, libras %s NOT NULL, hoja_ruta TEXT NOT NULL UNIQUE,
            placa TEXT NOT NULL, registrado_por TEXT DEFAULT '')""" % (ID, N),
        "CREATE INDEX IF NOT EXISTS ix_ventas_entrada ON ventas(entrada_id)",
        "CREATE INDEX IF NOT EXISTS ix_salidas_venta ON salidas(venta_id)",
        "CREATE INDEX IF NOT EXISTS ix_entradas_fecha ON entradas(fecha)",
    ]


def iniciar_bd():
    print("Base de datos: %s" % ("PostgreSQL (" + BD.params["host"] + ")" if ES_PG else "SQLite (" + DB_PATH + ")"))
    with LOCK, BD.sesion() as bd:
        for sql in esquema():
            bd.ejecutar(sql)
        # Migración: bases creadas con la versión anterior no tenían 'registrado_por'
        for t in ("entradas", "ventas", "salidas"):
            if ES_PG:
                bd.ejecutar("ALTER TABLE %s ADD COLUMN IF NOT EXISTS registrado_por TEXT DEFAULT ''" % t)
            elif "registrado_por" not in [c["name"] for c in bd.todos("PRAGMA table_info(%s)" % t)]:
                bd.ejecutar("ALTER TABLE %s ADD COLUMN registrado_por TEXT DEFAULT ''" % t)
        crear_admin_inicial(bd)
        if os.environ.get("DATOS_DEMO", "1") != "0" and not bd.valor("SELECT COUNT(*) FROM entradas"):
            print("Base vacía: generando 60 días de datos de ejemplo...")
            generar_datos_ejemplo(bd)


# ---------------------------------------------------------------------------
# Usuarios y sesiones
# ---------------------------------------------------------------------------
def hash_clave(clave, sal=None, iteraciones=200000):
    sal = sal or secrets.token_hex(16)
    h = hashlib.pbkdf2_hmac("sha256", clave.encode("utf-8"), bytes.fromhex(sal), iteraciones).hex()
    return "pbkdf2$%d$%s$%s" % (iteraciones, sal, h)


def verificar_clave(clave, guardada):
    try:
        _, it, sal, h = guardada.split("$")
        return hmac.compare_digest(hash_clave(clave, sal, int(it)).split("$")[3], h)
    except (ValueError, AttributeError):
        return False


def crear_admin_inicial(bd):
    if bd.valor("SELECT COUNT(*) FROM usuarios"):
        return
    usuario = os.environ.get("ADMIN_USUARIO", "admin").strip().lower() or "admin"
    clave = os.environ.get("ADMIN_CLAVE", "")
    if not clave:
        clave = secrets.token_urlsafe(9) if EN_LA_NUBE else "admin123"
    bd.insertar("INSERT INTO usuarios (usuario, nombre, clave, rol, activo, creado) VALUES (?,?,?,?,1,?)",
                (usuario, "Administrador", hash_clave(clave), "admin", ahora_utc()))
    print("*" * 60)
    print(" Usuario administrador creado:  %s" % usuario)
    if not os.environ.get("ADMIN_CLAVE"):
        print(" Contraseña:                    %s   (cámbiela al ingresar)" % clave)
    print("*" * 60)


def _hash_token(token):
    return hashlib.sha256(token.encode()).hexdigest()


def usuario_de_token(bd, token):
    if not token:
        return None
    return bd.uno("""SELECT u.id, u.usuario, u.nombre, u.rol FROM sesiones s JOIN usuarios u ON u.id = s.usuario_id
                     WHERE s.token = ? AND s.expira > ? AND u.activo = 1""", (_hash_token(token), ahora_utc()))


INTENTOS = {}  # ip -> [timestamps de intentos fallidos]


def login(datos, ip):
    ahora = time.time()
    fallos = [t for t in INTENTOS.get(ip, []) if ahora - t < 600]
    INTENTOS[ip] = fallos
    if len(fallos) >= 6:
        return 429, {"errores": ["Demasiados intentos fallidos. Espere unos minutos e intente de nuevo."]}, None
    usuario = str(datos.get("usuario") or "").strip().lower()
    clave = str(datos.get("clave") or "")
    if not usuario or not clave:
        return 400, {"errores": ["Ingrese usuario y contraseña."]}, None
    with BD.sesion() as bd:
        u = bd.uno("SELECT * FROM usuarios WHERE usuario = ?", (usuario,))
        if not u or not u["activo"] or not verificar_clave(clave, u["clave"]):
            fallos.append(ahora)
            return 401, {"errores": ["Usuario o contraseña incorrectos."]}, None
    token = secrets.token_urlsafe(32)
    expira = (datetime.now(timezone.utc) + DURACION_SESION).strftime("%Y-%m-%dT%H:%M:%S")
    with LOCK, BD.sesion() as bd:
        bd.ejecutar("DELETE FROM sesiones WHERE expira < ?", (ahora_utc(),))
        bd.ejecutar("INSERT INTO sesiones (token, usuario_id, expira) VALUES (?,?,?)",
                    (_hash_token(token), u["id"], expira))
    INTENTOS.pop(ip, None)
    return 200, {"ok": True, "usuario": _publico(u)}, token


def _publico(u):
    return {"id": u["id"], "usuario": u["usuario"], "nombre": u["nombre"], "rol": u["rol"],
            "rol_nombre": ROLES.get(u["rol"], u["rol"])}


def logout(token):
    if token:
        with LOCK, BD.sesion() as bd:
            bd.ejecutar("DELETE FROM sesiones WHERE token = ?", (_hash_token(token),))


def cambiar_clave(datos, usr):
    actual, nueva = str(datos.get("actual") or ""), str(datos.get("nueva") or "")
    errores = []
    if len(nueva) < 6:
        errores.append("La nueva contraseña debe tener al menos 6 caracteres.")
    with BD.sesion() as bd:
        u = bd.uno("SELECT * FROM usuarios WHERE id = ?", (usr["id"],))
        if not verificar_clave(actual, u["clave"]):
            errores.append("La contraseña actual no es correcta.")
    if errores:
        return 400, {"errores": errores}
    with LOCK, BD.sesion() as bd:
        bd.ejecutar("UPDATE usuarios SET clave = ? WHERE id = ?", (hash_clave(nueva), usr["id"]))
    return 200, {"ok": True, "mensaje": "Contraseña actualizada."}


def listar_usuarios():
    with BD.sesion() as bd:
        return [dict(_publico(u), activo=bool(u["activo"]), creado=u["creado"])
                for u in bd.todos("SELECT * FROM usuarios ORDER BY id")]


def crear_usuario(datos):
    errores = []
    usuario = str(datos.get("usuario") or "").strip().lower()
    nombre = str(datos.get("nombre") or "").strip()
    clave = str(datos.get("clave") or "")
    rol = str(datos.get("rol") or "operador")
    if not RE_USUARIO.match(usuario):
        errores.append("El usuario debe tener de 3 a 30 caracteres: letras minúsculas, números, punto o guion bajo.")
    if not nombre:
        errores.append("El campo «Nombre completo» es obligatorio.")
    if len(clave) < 6:
        errores.append("La contraseña debe tener al menos 6 caracteres.")
    if rol not in ROLES:
        errores.append("Rol no válido.")
    if errores:
        return 400, {"errores": errores}
    with LOCK, BD.sesion() as bd:
        if bd.valor("SELECT COUNT(*) FROM usuarios WHERE usuario = ?", (usuario,)):
            return 400, {"errores": ["Ya existe el usuario «%s»." % usuario]}
        nid = bd.insertar("INSERT INTO usuarios (usuario, nombre, clave, rol, activo, creado) VALUES (?,?,?,?,1,?)",
                          (usuario, nombre, hash_clave(clave), rol, ahora_utc()))
    return 201, {"ok": True, "id": nid, "mensaje": "Usuario «%s» creado." % usuario}


def estado_usuario(uid, datos, usr):
    activo = 1 if datos.get("activo") else 0
    if uid == usr["id"] and not activo:
        return 400, {"errores": ["No puede desactivar su propio usuario."]}
    with LOCK, BD.sesion() as bd:
        if not bd.uno("SELECT id FROM usuarios WHERE id = ?", (uid,)):
            return 404, {"errores": ["El usuario no existe."]}
        bd.ejecutar("UPDATE usuarios SET activo = ? WHERE id = ?", (activo, uid))
        if not activo:
            bd.ejecutar("DELETE FROM sesiones WHERE usuario_id = ?", (uid,))
    return 200, {"ok": True, "mensaje": "Usuario %s." % ("activado" if activo else "desactivado")}


# ---------------------------------------------------------------------------
# Saldos y hoja de ruta
# ---------------------------------------------------------------------------
def siguiente_hoja_ruta(bd, anio):
    prefijo = "HR-%d-" % anio
    ultimo = bd.valor("SELECT hoja_ruta FROM salidas WHERE hoja_ruta LIKE ? ORDER BY hoja_ruta DESC LIMIT 1",
                      (prefijo + "%",))
    n = int(ultimo.split("-")[-1]) + 1 if ultimo else 1
    return "%s%06d" % (prefijo, n)


def saldo_entrada(bd, entrada_id):
    v = bd.valor("SELECT e.libras - COALESCE((SELECT SUM(libras) FROM ventas WHERE entrada_id = e.id), 0)"
                 " FROM entradas e WHERE e.id = ?", (entrada_id,))
    return None if v is None else round(v, 2)


def saldo_venta(bd, venta_id):
    v = bd.valor("SELECT v.libras - COALESCE((SELECT SUM(libras) FROM salidas WHERE venta_id = v.id), 0)"
                 " FROM ventas v WHERE v.id = ?", (venta_id,))
    return None if v is None else round(v, 2)


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
PESO_PROCEDENCIA = {"Villa Fátima (La Paz)": [35, 33, 13, 8, 5, 6], "Sacaba (Cochabamba)": [55, 22, 14, 9]}
PESO_DEPTO = {"Santa Cruz": 39, "Tarija": 17, "Cochabamba": 12, "Oruro": 8, "Potosí": 7,
              "Chuquisaca": 6, "La Paz": 6, "Beni": 4, "Pando": 1}
DEMO = "sistema (datos de ejemplo)"


def _persona(rnd):
    nombre = "%s %s %s" % (rnd.choice(NOMBRES), rnd.choice(APELLIDOS), rnd.choice(APELLIDOS))
    ci = str(rnd.randint(2000000, 13999999))
    if rnd.random() < 0.15:
        ci += "-" + rnd.choice(["1A", "1B", "2C", "1K", "LP"])
    return nombre, ci


def _partir(total, partes, rnd):
    if partes <= 1 or total < 20 * partes:
        return [round(total, 2)]
    pesos = [rnd.uniform(0.6, 1.4) for _ in range(partes)]
    s = sum(pesos)
    trozos = [round(total * p / s * 2) / 2 for p in pesos[:-1]]
    trozos.append(round(total - sum(trozos), 2))
    return [t for t in trozos if t > 0]


def generar_datos_ejemplo(bd):
    rnd = random.Random(2026)
    hoy = hoy_bolivia()
    deptos, pesos_depto = list(PESO_DEPTO.keys()), list(PESO_DEPTO.values())
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

    entradas, info_e = [], []
    for d in range(59, -1, -1):
        f = hoy - timedelta(days=d)
        for _ in range(rnd.randint(4, 8)):
            p = rnd.choice(prod_vf if rnd.random() < 0.88 else prod_sa)
            taques = rnd.choices([1, 2, 3, 4, 5, 6, 8, 10, 12], [5, 12, 16, 18, 16, 13, 10, 6, 4])[0]
            libras = round(taques * LIBRAS_POR_TAQUE * rnd.uniform(0.95, 1.07) * 2) / 2
            eid = len(entradas) + 1
            entradas.append((eid, f.isoformat(), p[0], p[2], p[3], p[1], taques, libras, rnd.choice(obs), DEMO))
            info_e.append((eid, f, libras, d))

    ventas = []
    for eid, f, libras, d in info_e:
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
            comp = rnd.choice(compradores)
            ventas.append([fv, eid, comp[0], comp[1], trozo, round(rnd.uniform(35, 45) * 2) / 2])
    ventas.sort(key=lambda v: (v[0], v[1]))
    filas_v = [(i + 1, v[0].isoformat(), v[1], v[2], v[3], v[4], v[5], round(v[4] * v[5], 2), DEMO)
               for i, v in enumerate(ventas)]

    salidas = []
    for vid, fv_iso, _, _, _, lb, _, _, _ in filas_v:
        fv = datetime.strptime(fv_iso, "%Y-%m-%d").date()
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
    contador, filas_s = {}, []
    for i, (fs, vid, depto, lb, placa) in enumerate(salidas):
        contador[fs.year] = contador.get(fs.year, 0) + 1
        filas_s.append((i + 1, fs.isoformat(), vid, depto, lb, "HR-%d-%06d" % (fs.year, contador[fs.year]), placa, DEMO))

    bd.lote("entradas", ["id", "fecha", "mercado", "productor", "ci", "procedencia", "taques", "libras",
                         "observacion", "registrado_por"], entradas)
    bd.lote("ventas", ["id", "fecha", "entrada_id", "comprador", "ci_comprador", "libras", "precio_libra",
                       "total", "registrado_por"], filas_v)
    bd.lote("salidas", ["id", "fecha", "venta_id", "departamento", "libras", "hoja_ruta", "placa",
                        "registrado_por"], filas_s)
    if ES_PG:
        for t in ("entradas", "ventas", "salidas"):
            bd.ejecutar("SELECT setval(pg_get_serial_sequence('%s', 'id'), (SELECT MAX(id) FROM %s))" % (t, t))
    print("  %d entradas, %d ventas, %d salidas generadas." % (len(entradas), len(filas_v), len(filas_s)))


# ---------------------------------------------------------------------------
# Validación y registro
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
    if n != n or n in (float("inf"), float("-inf")):
        errores.append("«%s» debe ser un número." % nombre)
        return None
    if n <= 0:
        errores.append("«%s» debe ser mayor que 0." % nombre)
        return None
    if n > 1000000:
        errores.append("«%s» es demasiado grande." % nombre)
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


def _obligatorio(datos, campo, nombre, errores, largo=120):
    v = _texto(datos, campo)[:largo]
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


def _firma(usr):
    return "%s (%s)" % (usr["nombre"], usr["usuario"])


def crear_entrada(datos, usr):
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
    with LOCK, BD.sesion() as bd:
        nid = bd.insertar(
            "INSERT INTO entradas (fecha, mercado, productor, ci, procedencia, taques, libras, observacion, registrado_por)"
            " VALUES (?,?,?,?,?,?,?,?,?)",
            (fecha, mercado, productor, ci, procedencia, taques, libras, observacion, _firma(usr)))
    return 201, {"ok": True, "id": nid, "avisos": avisos, "mensaje": "Entrada Nº %d registrada." % nid}


def crear_venta(datos, usr):
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
    with LOCK, BD.sesion() as bd:
        ent = bd.uno("SELECT * FROM entradas WHERE id = ?", (int(entrada_id),))
        if ent is None:
            return 400, {"errores": ["La entrada Nº %s no existe." % entrada_id]}
        if fecha < ent["fecha"]:
            errores.append("La fecha de venta no puede ser anterior a la fecha de entrada (%s)." % ent["fecha"])
        saldo = saldo_entrada(bd, ent["id"])
        if libras > saldo + 1e-9:
            errores.append("La venta (%s lb) supera lo que queda sin vender de la entrada Nº %d (%s lb)."
                           % (_n(libras), ent["id"], _n(saldo)))
        if errores:
            return 400, {"errores": errores}
        total = round(libras * precio, 2)
        nid = bd.insertar(
            "INSERT INTO ventas (fecha, entrada_id, comprador, ci_comprador, libras, precio_libra, total, registrado_por)"
            " VALUES (?,?,?,?,?,?,?,?)", (fecha, ent["id"], comprador, ci, libras, precio, total, _firma(usr)))
    return 201, {"ok": True, "id": nid, "total": total, "avisos": [], "mensaje": "Venta Nº %d registrada." % nid}


def crear_salida(datos, usr):
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
    with LOCK, BD.sesion() as bd:
        ven = bd.uno("SELECT * FROM ventas WHERE id = ?", (int(venta_id),))
        if ven is None:
            return 400, {"errores": ["La venta Nº %s no existe." % venta_id]}
        if fecha < ven["fecha"]:
            errores.append("La fecha de salida no puede ser anterior a la fecha de venta (%s)." % ven["fecha"])
        saldo = saldo_venta(bd, ven["id"])
        if libras > saldo + 1e-9:
            errores.append("La salida (%s lb) supera lo vendido que aún no salió de la venta Nº %d (%s lb)."
                           % (_n(libras), ven["id"], _n(saldo)))
        if errores:
            return 400, {"errores": errores}
        codigo = siguiente_hoja_ruta(bd, int(fecha[:4]))
        nid = bd.insertar(
            "INSERT INTO salidas (fecha, venta_id, departamento, libras, hoja_ruta, placa, registrado_por)"
            " VALUES (?,?,?,?,?,?,?)", (fecha, ven["id"], departamento, libras, codigo, placa, _firma(usr)))
    return 201, {"ok": True, "id": nid, "hoja_ruta": codigo, "avisos": [],
                 "mensaje": "Salida registrada con hoja de ruta %s." % codigo}


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
  SELECT e.*, %s AS saldo FROM entradas e
) t
""" % R("e.libras - COALESCE((SELECT SUM(v.libras) FROM ventas v WHERE v.entrada_id = e.id), 0)")
SQL_VENTAS = """
SELECT * FROM (
  SELECT v.*, e.mercado, e.procedencia, e.productor, e.fecha AS fecha_entrada, %s AS saldo
  FROM ventas v JOIN entradas e ON e.id = v.entrada_id
) t
""" % R("v.libras - COALESCE((SELECT SUM(s.libras) FROM salidas s WHERE s.venta_id = v.id), 0)")
SQL_SALIDAS = """
SELECT s.*, v.comprador, v.ci_comprador, v.fecha AS fecha_venta, v.precio_libra,
       e.id AS entrada_id, e.mercado, e.procedencia, e.productor, e.ci AS ci_productor, e.fecha AS fecha_entrada
FROM salidas s JOIN ventas v ON v.id = s.venta_id JOIN entradas e ON e.id = v.entrada_id
"""


def listar_entradas(qs):
    cond, par = [], []
    q = qs.get("q", "").strip()
    if q:
        cond.append("(productor {0} ? OR ci {0} ? OR procedencia {0} ? OR mercado {0} ? OR CAST(id AS TEXT) = ?)".format(LIKE()))
        par += ["%" + q + "%"] * 4 + [q.lstrip("#")]
    if qs.get("con_saldo") == "1":
        cond.append("saldo > 0.004")
    if qs.get("mercado"):
        cond.append("mercado = ?")
        par.append(qs["mercado"])
    sql = SQL_ENTRADAS + (" WHERE " + " AND ".join(cond) if cond else "") + " ORDER BY fecha DESC, id DESC LIMIT 500"
    with BD.sesion() as bd:
        return bd.todos(sql, par)


def listar_ventas(qs):
    cond, par = [], []
    q = qs.get("q", "").strip()
    if q:
        cond.append("(comprador {0} ? OR ci_comprador {0} ? OR productor {0} ? OR procedencia {0} ?"
                    " OR CAST(id AS TEXT) = ?)".format(LIKE()))
        par += ["%" + q + "%"] * 4 + [q.lstrip("#")]
    if qs.get("con_saldo") == "1":
        cond.append("saldo > 0.004")
    sql = SQL_VENTAS + (" WHERE " + " AND ".join(cond) if cond else "") + " ORDER BY fecha DESC, id DESC LIMIT 500"
    with BD.sesion() as bd:
        return bd.todos(sql, par)


def listar_salidas(qs, limite=500):
    cond, par = [], []
    if qs.get("departamento"):
        cond.append("s.departamento = ?")
        par.append(qs["departamento"])
    q = qs.get("q", "").strip()
    if q:
        cond.append("(s.hoja_ruta {0} ? OR s.placa {0} ? OR v.comprador {0} ?)".format(LIKE()))
        par += ["%" + q + "%"] * 3
    c2, p2 = _filtros_fecha_mercado(qs, "s.fecha")
    sql = SQL_SALIDAS + _where(cond + c2) + " ORDER BY s.fecha DESC, s.id DESC"
    if limite:
        sql += " LIMIT %d" % limite
    with BD.sesion() as bd:
        return bd.todos(sql, par + p2)


def hoja_ruta(codigo):
    with BD.sesion() as bd:
        return bd.uno(SQL_SALIDAS + " WHERE s.hoja_ruta = ?", (codigo.strip().upper(),))


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
    ce, pe = _filtros_fecha_mercado(qs, "e.fecha")
    cv, pv = _filtros_fecha_mercado(qs, "v.fecha")
    cs, ps = _filtros_fecha_mercado(qs, "s.fecha")
    FROM_V = " FROM ventas v JOIN entradas e ON e.id = v.entrada_id"
    FROM_S = " FROM salidas s JOIN ventas v ON v.id = s.venta_id JOIN entradas e ON e.id = v.entrada_id"
    with BD.sesion() as bd:
        r = bd.uno("SELECT COUNT(*) AS n, COALESCE(SUM(libras),0) AS lb, COALESCE(SUM(taques),0) AS tq FROM entradas e"
                   + _where(ce), pe)
        entradas = {"cantidad": r["n"], "libras": round(r["lb"], 2), "taques": round(r["tq"], 2)}
        r = bd.uno("SELECT COUNT(*) AS n, COALESCE(SUM(v.libras),0) AS lb, COALESCE(SUM(v.total),0) AS m" + FROM_V
                   + _where(cv), pv)
        ventas = {"cantidad": r["n"], "libras": round(r["lb"], 2), "monto": round(r["m"], 2)}
        r = bd.uno("SELECT COUNT(*) AS n, COALESCE(SUM(s.libras),0) AS lb" + FROM_S + _where(cs), ps)
        salidas = {"cantidad": r["n"], "libras": round(r["lb"], 2), "hojas_ruta": r["n"]}
        precio_promedio = round(ventas["monto"] / ventas["libras"], 2) if ventas["libras"] else 0

        # Inventario actual (no depende de las fechas, solo del mercado)
        cm, pm = (" WHERE mercado = ?", [qs["mercado"]]) if qs.get("mercado") else ("", [])
        sin_vender = bd.valor("SELECT COALESCE(SUM(saldo),0) FROM (" + SQL_ENTRADAS + cm + ") x", pm)
        sin_salir = bd.valor("SELECT COALESCE(SUM(saldo),0) FROM (" + SQL_VENTAS + cm + ") x", pm)
        inventario = {"sin_vender": round(sin_vender, 2), "vendida_sin_salir": round(sin_salir, 2),
                      "total_en_mercado": round(sin_vender + sin_salir, 2),
                      "taques_equivalentes": round((sin_vender + sin_salir) / LIBRAS_POR_TAQUE, 1)}

        datos = {f["d"]: (f["lb"], f["n"]) for f in bd.todos(
            "SELECT s.departamento AS d, SUM(s.libras) AS lb, COUNT(*) AS n" + FROM_S + _where(cs)
            + " GROUP BY s.departamento", ps)}
        total_s = sum(v[0] for v in datos.values()) or 0
        por_departamento = []
        for d in DEPARTAMENTOS:
            lb, n = datos.get(d, (0, 0))
            por_departamento.append({"departamento": d, "libras": round(lb, 2), "hojas_ruta": n,
                                     "porcentaje": round(lb * 100 / total_s, 2) if total_s else 0})
        por_departamento.sort(key=lambda x: -x["libras"])

        filas = bd.todos("SELECT e.mercado AS m, e.procedencia AS p, COUNT(*) AS n, SUM(e.libras) AS lb,"
                         " SUM(e.taques) AS tq FROM entradas e" + _where(ce)
                         + " GROUP BY e.mercado, e.procedencia ORDER BY SUM(e.libras) DESC", pe)
        por_procedencia = [{"mercado": f["m"], "procedencia": f["p"], "entradas": f["n"], "libras": round(f["lb"], 2),
                            "taques": round(f["tq"], 2),
                            "porcentaje": round(f["lb"] * 100 / entradas["libras"], 2) if entradas["libras"] else 0}
                           for f in filas]

        meses = {}
        for f in bd.todos("SELECT substr(e.fecha,1,7) AS m, SUM(e.libras) AS lb, COUNT(*) AS n FROM entradas e"
                          + _where(ce) + " GROUP BY substr(e.fecha,1,7)", pe):
            meses.setdefault(f["m"], {}).update(entradas_lb=round(f["lb"], 2), entradas_n=f["n"])
        for f in bd.todos("SELECT substr(v.fecha,1,7) AS m, SUM(v.libras) AS lb, SUM(v.total) AS t" + FROM_V
                          + _where(cv) + " GROUP BY substr(v.fecha,1,7)", pv):
            meses.setdefault(f["m"], {}).update(ventas_lb=round(f["lb"], 2), monto=round(f["t"], 2))
        for f in bd.todos("SELECT substr(s.fecha,1,7) AS m, SUM(s.libras) AS lb, COUNT(*) AS n" + FROM_S
                          + _where(cs) + " GROUP BY substr(s.fecha,1,7)", ps):
            meses.setdefault(f["m"], {}).update(salidas_lb=round(f["lb"], 2), hojas_ruta=f["n"])
        por_mes = [{"mes": m, "entradas_lb": d.get("entradas_lb", 0), "entradas_n": d.get("entradas_n", 0),
                    "ventas_lb": d.get("ventas_lb", 0), "monto": d.get("monto", 0),
                    "salidas_lb": d.get("salidas_lb", 0), "hojas_ruta": d.get("hojas_ruta", 0)}
                   for m, d in sorted(meses.items())]

        try:
            fin = datetime.strptime(qs.get("hasta", ""), "%Y-%m-%d").date()
        except ValueError:
            fin = hoy_bolivia()
        ini = fin - timedelta(days=29)
        cd, pd = ["e.fecha >= ?", "e.fecha <= ?"], [ini.isoformat(), fin.isoformat()]
        if qs.get("mercado"):
            cd.append("e.mercado = ?")
            pd.append(qs["mercado"])
        dias = {f["f"]: (f["lb"], f["n"]) for f in bd.todos(
            "SELECT e.fecha AS f, SUM(e.libras) AS lb, COUNT(*) AS n FROM entradas e" + _where(cd)
            + " GROUP BY e.fecha", pd)}
        dias_v = {f["f"]: f["lb"] for f in bd.todos(
            "SELECT s.fecha AS f, SUM(s.libras) AS lb" + FROM_S + _where([c.replace("e.fecha", "s.fecha") for c in cd])
            + " GROUP BY s.fecha", pd)}
        por_dia = []
        for i in range(30):
            d = (ini + timedelta(days=i)).isoformat()
            lb, n = dias.get(d, (0, 0))
            por_dia.append({"fecha": d, "libras": round(lb, 2), "entradas": n,
                            "salidas_lb": round(dias_v.get(d, 0), 2)})

        ultimas = bd.todos("SELECT s.hoja_ruta, s.fecha, s.departamento, s.libras, e.mercado" + FROM_S
                           + _where(cs) + " ORDER BY s.id DESC LIMIT 6", ps)

    return {"filtros": {k: qs.get(k, "") for k in ("desde", "hasta", "mercado")},
            "entradas": entradas, "ventas": ventas, "salidas": salidas,
            "precio_promedio": precio_promedio, "inventario": inventario,
            "por_departamento": por_departamento, "por_procedencia": por_procedencia,
            "por_mes": por_mes, "por_dia": por_dia, "ultimas_salidas": ultimas,
            "base_datos": "PostgreSQL" if ES_PG else "SQLite"}


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
                "Nº venta", "Mercado", "Procedencia", "Productor", "Nº entrada", "Registrado por"])
    for s in listar_salidas(qs, limite=0):
        w.writerow([s["hoja_ruta"], s["fecha"], s["departamento"], _dec(s["libras"]), s["placa"], s["comprador"],
                    s["ci_comprador"], s["venta_id"], s["mercado"], s["procedencia"], s["productor"],
                    s["entrada_id"], s.get("registrado_por") or ""])
    return buf.getvalue()


# ---------------------------------------------------------------------------
# Servidor HTTP
# ---------------------------------------------------------------------------
TIPOS = {".html": "text/html; charset=utf-8", ".js": "application/javascript; charset=utf-8",
         ".css": "text/css; charset=utf-8", ".png": "image/png", ".svg": "image/svg+xml",
         ".ico": "image/x-icon", ".txt": "text/plain; charset=utf-8", ".json": "application/json"}
COOKIE = "sesion_coca"


class Manejador(BaseHTTPRequestHandler):
    server_version = "ControlCoca/2.0"
    sys_version = ""

    def log_message(self, fmt, *args):
        if "/api/" in (self.path or ""):
            sys.stderr.write("%s  %s\n" % (self.log_date_time_string(), fmt % args))

    # ---- utilidades de respuesta
    def _enviar(self, codigo, cuerpo, tipo, extra=None):
        datos = cuerpo.encode("utf-8") if isinstance(cuerpo, str) else cuerpo
        self.send_response(codigo)
        self.send_header("Content-Type", tipo)
        self.send_header("Content-Length", str(len(datos)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Referrer-Policy", "same-origin")
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(datos)

    def _json(self, codigo, obj, extra=None):
        self._enviar(codigo, json.dumps(obj, ensure_ascii=False), "application/json; charset=utf-8", extra)

    def _csv(self, nombre, texto):
        self._enviar(200, "﻿" + texto, "text/csv; charset=utf-8",
                     {"Content-Disposition": 'attachment; filename="%s"' % nombre})

    def _token(self):
        c = SimpleCookie()
        try:
            c.load(self.headers.get("Cookie") or "")
        except Exception:
            return None
        return c[COOKIE].value if COOKIE in c else None

    def _cookie(self, token, segundos):
        seguro = "; Secure" if self.headers.get("X-Forwarded-Proto") == "https" else ""
        return "%s=%s; Path=/; HttpOnly; SameSite=Lax; Max-Age=%d%s" % (COOKIE, token, segundos, seguro)

    def _usuario(self):
        tok = self._token()
        if not tok:
            return None
        with BD.sesion() as bd:
            return usuario_de_token(bd, tok)

    def _ip(self):
        return (self.headers.get("X-Forwarded-For") or self.client_address[0]).split(",")[0].strip()

    NO_AUT = {"errores": ["Debe iniciar sesión para realizar esta acción."]}
    NO_ADMIN = {"errores": ["Solo un administrador puede realizar esta acción."]}

    # ---- GET
    def do_HEAD(self):
        self.do_GET()

    def do_GET(self):
        url = urlparse(self.path)
        qs = {k: v[0] for k, v in parse_qs(url.query).items()}
        try:
            if url.path.startswith("/api/"):
                return self._api_get(url.path, qs)
            return self._estatico(url.path)
        except Exception as e:
            sys.stderr.write("ERROR %s: %r\n" % (self.path, e))
            self._json(500, {"errores": ["Error interno del servidor. Intente de nuevo."]})

    def _api_get(self, ruta, qs):
        if ruta == "/api/config":
            return self._json(200, {"mercados": MERCADOS, "departamentos": DEPARTAMENTOS,
                                    "libras_por_taque": LIBRAS_POR_TAQUE, "tolerancia_peso": TOLERANCIA_PESO,
                                    "hoy": hoy_bolivia().isoformat(), "roles": ROLES})
        if ruta == "/api/sesion":
            u = self._usuario()
            return self._json(200, {"usuario": _publico(u) if u else None})
        if ruta == "/api/resumen":
            return self._json(200, resumen(qs))
        if ruta.startswith("/api/hoja-ruta/"):
            codigo = unquote(ruta[len("/api/hoja-ruta/"):])[:40]
            hr = hoja_ruta(codigo)
            if hr is None:
                return self._json(404, {"errores": ["La hoja de ruta «%s» no existe." % codigo]})
            return self._json(200, hr)
        if ruta == "/api/exportar/departamentos.csv":
            return self._csv("departamentos.csv", csv_departamentos(qs))

        # --- a partir de aquí se requiere sesión
        usr = self._usuario()
        privadas = {"/api/entradas": listar_entradas, "/api/ventas": listar_ventas, "/api/salidas": listar_salidas}
        if ruta in privadas or ruta in ("/api/exportar/salidas.csv", "/api/usuarios"):
            if not usr:
                return self._json(401, self.NO_AUT)
            if ruta in privadas:
                return self._json(200, privadas[ruta](qs))
            if ruta == "/api/exportar/salidas.csv":
                return self._csv("salidas.csv", csv_salidas(qs))
            if usr["rol"] != "admin":
                return self._json(403, self.NO_ADMIN)
            return self._json(200, listar_usuarios())
        return self._json(404, {"errores": ["Ruta no encontrada."]})

    # ---- POST
    def do_POST(self):
        ruta = urlparse(self.path).path
        try:
            largo = int(self.headers.get("Content-Length") or 0)
            if largo > 100000:
                return self._json(413, {"errores": ["Petición demasiado grande."]})
            crudo = self.rfile.read(largo) if largo else b"{}"
            if "application/json" not in (self.headers.get("Content-Type") or ""):
                return self._json(415, {"errores": ["Se esperaba contenido JSON."]})
            try:
                datos = json.loads(crudo.decode("utf-8") or "{}")
                if not isinstance(datos, dict):
                    raise ValueError
            except ValueError:
                return self._json(400, {"errores": ["El cuerpo de la petición debe ser JSON válido."]})

            if ruta == "/api/login":
                codigo, resp, token = login(datos, self._ip())
                extra = {"Set-Cookie": self._cookie(token, int(DURACION_SESION.total_seconds()))} if token else None
                return self._json(codigo, resp, extra)
            if ruta == "/api/logout":
                logout(self._token())
                return self._json(200, {"ok": True}, {"Set-Cookie": self._cookie("", 0)})

            usr = self._usuario()
            if not usr:
                return self._json(401, self.NO_AUT)
            acciones = {"/api/entradas": crear_entrada, "/api/ventas": crear_venta, "/api/salidas": crear_salida,
                        "/api/clave": cambiar_clave}
            if ruta in acciones:
                codigo, resp = acciones[ruta](datos, usr)
                return self._json(codigo, resp)
            if ruta == "/api/usuarios" or ruta.startswith("/api/usuarios/"):
                if usr["rol"] != "admin":
                    return self._json(403, self.NO_ADMIN)
                if ruta == "/api/usuarios":
                    return self._json(*crear_usuario(datos))
                m = re.match(r"^/api/usuarios/(\d+)/estado$", ruta)
                if m:
                    return self._json(*estado_usuario(int(m.group(1)), datos, usr))
            return self._json(404, {"errores": ["Ruta no encontrada."]})
        except Exception as e:
            sys.stderr.write("ERROR %s: %r\n" % (self.path, e))
            self._json(500, {"errores": ["Error interno del servidor. Intente de nuevo."]})

    def _estatico(self, ruta):
        if ruta in ("/", ""):
            ruta = "/index.html"
        destino = os.path.normpath(os.path.join(STATIC_DIR, unquote(ruta).lstrip("/")))
        if not destino.startswith(STATIC_DIR + os.sep) or not os.path.isfile(destino):
            return self._enviar(404, "No encontrado", "text/plain; charset=utf-8")
        with open(destino, "rb") as f:
            datos = f.read()
        tipo = TIPOS.get(os.path.splitext(destino)[1].lower(), "application/octet-stream")
        self._enviar(200, datos, tipo)


def main():
    puerto = int(sys.argv[1]) if len(sys.argv) > 1 else PORT
    iniciar_bd()
    servidor = ThreadingHTTPServer((HOST, puerto), Manejador)
    servidor.daemon_threads = True
    print("=" * 60)
    print(" Sistema de Control de Comercialización de la Hoja de Coca")
    if not EN_LA_NUBE:
        print(" Abra en su navegador:  http://localhost:%d" % puerto)
        print(" Presione Ctrl+C para detener el servidor.")
    else:
        print(" Escuchando en el puerto %d" % puerto)
    print("=" * 60)
    sys.stdout.flush()
    try:
        servidor.serve_forever()
    except KeyboardInterrupt:
        print("\nServidor detenido.")
    finally:
        servidor.server_close()


if __name__ == "__main__":
    main()
