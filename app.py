# -*- coding: utf-8 -*-
"""
Sistema de Control de Comercialización de la Hoja de Coca  (versión 3)
Proyecto académico (Bolivia).

Ejecutar:  python app.py      (o  py app.py)   ->  http://localhost:8000
Base de datos: SQLite (control.db), solo biblioteca estándar de Python.

Opcional (publicación en internet): si existe la variable DATABASE_URL=postgresql://...
se usa PostgreSQL con el conector pg8000 (pip install pg8000), para que los datos no se borren.

Variables de entorno opcionales:
  PORT          puerto (Render lo asigna)          CONTROL_DB   ruta del archivo SQLite
  ADMIN_CLAVE   contraseña inicial de "admin"      DATOS_DEMO   "0" = no generar datos de ejemplo
"""
import csv
import hashlib
import hmac
import io
import json
import math
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

# ===========================================================================
# Configuración general
# ===========================================================================
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
STATIC_DIR = os.path.join(BASE_DIR, "static")
DB_PATH = os.environ.get("CONTROL_DB") or os.path.join(BASE_DIR, "control.db")
EN_LA_NUBE = bool(os.environ.get("PORT"))
HOST = "0.0.0.0" if EN_LA_NUBE else "127.0.0.1"
PORT = int(os.environ.get("PORT", "8000"))
DATABASE_URL = os.environ.get("DATABASE_URL", "").strip()
ES_PG = DATABASE_URL.startswith(("postgres://", "postgresql://"))
ZONA_BOLIVIA = timezone(timedelta(hours=-4))  # Bolivia: UTC-4 todo el año
VERSION_BD = 3

MERCADOS = {
    "Villa Fátima (La Paz)": ["Nor Yungas", "Sud Yungas", "Caranavi", "Inquisivi",
                              "Franz Tamayo (Apolo)", "Otra"],
    "Sacaba (Cochabamba)": ["Chapare", "Carrasco", "Tiraque", "Otra"],
}
DEPARTAMENTOS = ["La Paz", "Cochabamba", "Santa Cruz", "Oruro", "Potosí",
                 "Chuquisaca", "Tarija", "Beni", "Pando"]

ROLES = {"admin": "Administrador", "operador": "Operador", "supervisor": "Supervisor",
         "controlador": "Controlador"}
# Qué roles pueden usar cada grupo de funciones (se valida SIEMPRE en el servidor)
PERMISOS = {
    "panel": {"admin", "operador", "supervisor"},
    "registrar": {"admin", "operador"},
    "hoja": {"admin", "operador", "supervisor"},
    "hojas": {"admin", "supervisor"},
    "reportes": {"admin", "supervisor"},
    "verificar": {"admin", "controlador"},
    "admin": {"admin"},
}

CONFIG_DEFECTO = {"calidad_1": "Primera", "calidad_2": "Segunda", "calidad_3": "Tercera",
                  "libras_por_taque": "50", "vigencia_horas": "72"}
TOLERANCIA_PESO = 0.20       # aviso si el peso se aleja más de 20 % de lo esperado
TOLERANCIA_PRECIO = 0.30     # aviso si el precio se aleja más de 30 % de la referencia
INACTIVIDAD = timedelta(minutes=30)
MAX_INTENTOS = 5
TIEMPO_BLOQUEO = timedelta(minutes=5)
CLAVE_DEMO = "prueba123"

RE_CI = re.compile(r"^\d{5,10}(-[0-9A-Z]{1,3})?$")
RE_FECHA = re.compile(r"^\d{4}-\d{2}-\d{2}$")
RE_USUARIO = re.compile(r"^[a-z0-9_.]{3,30}$")
RE_PLACA = re.compile(r"^\d{3,4}[A-Z]{3}$")
RE_TELEFONO = re.compile(r"^[0-9+\- ]{7,15}$")

LOCK = threading.Lock()  # serializa escrituras (servidor multihilo)


def ahora():
    """Fecha y hora actual de Bolivia, sin zona (para guardar como texto)."""
    return datetime.now(ZONA_BOLIVIA).replace(tzinfo=None, microsecond=0)


def ts(d):
    return d.strftime("%Y-%m-%d %H:%M:%S")


def hoy():
    return ahora().date()


# ===========================================================================
# Capa de base de datos (SQLite; PostgreSQL opcional)
# ===========================================================================
pg8000 = None
if ES_PG:
    try:
        import pg8000.dbapi as pg8000
    except ImportError:
        sys.exit("Para usar PostgreSQL instale el conector:  pip install pg8000")


def _norm(v):
    return float(v) if isinstance(v, Decimal) else v


class Conexion:
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
        return [dict(zip(cols, [_norm(v) for v in f])) for f in cur.fetchall()]

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
        con.execute("PRAGMA journal_mode = WAL")
        return con

    def _obtener(self):
        while True:
            try:
                con, t = self.libres.get_nowait()
            except queue.Empty:
                return self._conectar()
            if time.time() - t < 30:
                return con
            try:
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

    def cerrar_todo(self):
        while True:
            try:
                _cerrar(self.libres.get_nowait()[0])
            except queue.Empty:
                return


BD = BaseDatos()


def R(expr):
    return "ROUND(CAST(%s AS NUMERIC), 2)" % expr


def LIKE():
    return "ILIKE" if ES_PG else "LIKE"


# ===========================================================================
# Esquema y migraciones
# ===========================================================================
def esquema():
    ID = "SERIAL PRIMARY KEY" if ES_PG else "INTEGER PRIMARY KEY AUTOINCREMENT"
    N = "DOUBLE PRECISION" if ES_PG else "REAL"
    return [
        """CREATE TABLE IF NOT EXISTS usuarios (
            id %s, usuario TEXT NOT NULL UNIQUE, nombre TEXT NOT NULL, clave TEXT NOT NULL,
            rol TEXT NOT NULL DEFAULT 'operador', mercado TEXT, activo INTEGER NOT NULL DEFAULT 1,
            debe_cambiar INTEGER DEFAULT 0, intentos_fallidos INTEGER DEFAULT 0, bloqueado_hasta TEXT,
            creado TEXT)""" % ID,
        """CREATE TABLE IF NOT EXISTS sesiones (
            token TEXT PRIMARY KEY, usuario_id INTEGER NOT NULL, creada TEXT, ultimo_uso TEXT)""",
        """CREATE TABLE IF NOT EXISTS config (clave TEXT PRIMARY KEY, valor TEXT NOT NULL)""",
        """CREATE TABLE IF NOT EXISTS entradas (
            id %s, fecha TEXT NOT NULL, hora TEXT DEFAULT '', mercado TEXT NOT NULL, productor TEXT NOT NULL,
            ci TEXT NOT NULL, telefono TEXT DEFAULT '', procedencia TEXT NOT NULL, calidad INTEGER DEFAULT 2,
            taques %s NOT NULL, libras %s NOT NULL, observacion TEXT DEFAULT '', usuario_id INTEGER,
            registrado_por TEXT DEFAULT '')""" % (ID, N, N),
        """CREATE TABLE IF NOT EXISTS ventas (
            id %s, fecha TEXT NOT NULL, hora TEXT DEFAULT '', entrada_id INTEGER NOT NULL REFERENCES entradas(id),
            comprador TEXT NOT NULL, ci_comprador TEXT NOT NULL, libras %s NOT NULL, precio_libra %s NOT NULL,
            total %s NOT NULL, calidad INTEGER DEFAULT 2, usuario_id INTEGER, registrado_por TEXT DEFAULT '')"""
        % (ID, N, N, N),
        """CREATE TABLE IF NOT EXISTS salidas (
            id %s, fecha TEXT NOT NULL, hora TEXT DEFAULT '', venta_id INTEGER NOT NULL REFERENCES ventas(id),
            departamento TEXT NOT NULL, libras %s NOT NULL, hoja_ruta TEXT NOT NULL UNIQUE,
            transportista TEXT DEFAULT '', ci_transportista TEXT DEFAULT '', placa TEXT DEFAULT '',
            emitida TEXT, vence TEXT, anulada INTEGER DEFAULT 0, motivo_anulacion TEXT, anulada_por TEXT,
            anulada_en TEXT, usuario_id INTEGER, registrado_por TEXT DEFAULT '')""" % (ID, N),
        """CREATE TABLE IF NOT EXISTS verificaciones (
            id %s, codigo TEXT NOT NULL, fecha_hora TEXT NOT NULL, usuario_id INTEGER, usuario TEXT,
            resultado TEXT NOT NULL, puesto TEXT DEFAULT '')""" % ID,
        """CREATE TABLE IF NOT EXISTS bitacora (
            id %s, fecha_hora TEXT NOT NULL, usuario_id INTEGER, usuario TEXT, accion TEXT NOT NULL,
            detalle TEXT DEFAULT '', ip TEXT DEFAULT '')""" % ID,
        "CREATE INDEX IF NOT EXISTS ix_ventas_entrada ON ventas(entrada_id)",
        "CREATE INDEX IF NOT EXISTS ix_salidas_venta ON salidas(venta_id)",
        "CREATE INDEX IF NOT EXISTS ix_entradas_fecha ON entradas(fecha)",
        "CREATE INDEX IF NOT EXISTS ix_verif_codigo ON verificaciones(codigo)",
        "CREATE INDEX IF NOT EXISTS ix_bitacora_fecha ON bitacora(fecha_hora)",
    ]


# Columnas agregadas después de la versión 1 (para migrar bases antiguas sin borrar datos)
COLUMNAS_NUEVAS = [
    ("usuarios", "mercado", "TEXT"), ("usuarios", "debe_cambiar", "INTEGER DEFAULT 0"),
    ("usuarios", "intentos_fallidos", "INTEGER DEFAULT 0"), ("usuarios", "bloqueado_hasta", "TEXT"),
    ("entradas", "hora", "TEXT DEFAULT ''"), ("entradas", "telefono", "TEXT DEFAULT ''"),
    ("entradas", "calidad", "INTEGER DEFAULT 2"), ("entradas", "usuario_id", "INTEGER"),
    ("entradas", "registrado_por", "TEXT DEFAULT ''"),
    ("ventas", "hora", "TEXT DEFAULT ''"), ("ventas", "calidad", "INTEGER DEFAULT 2"),
    ("ventas", "usuario_id", "INTEGER"), ("ventas", "registrado_por", "TEXT DEFAULT ''"),
    ("salidas", "hora", "TEXT DEFAULT ''"), ("salidas", "transportista", "TEXT DEFAULT ''"),
    ("salidas", "ci_transportista", "TEXT DEFAULT ''"), ("salidas", "emitida", "TEXT"),
    ("salidas", "vence", "TEXT"), ("salidas", "anulada", "INTEGER DEFAULT 0"),
    ("salidas", "motivo_anulacion", "TEXT"), ("salidas", "anulada_por", "TEXT"),
    ("salidas", "anulada_en", "TEXT"), ("salidas", "usuario_id", "INTEGER"),
    ("salidas", "registrado_por", "TEXT DEFAULT ''"),
]


def _columnas(bd, tabla):
    if ES_PG:
        return {f["column_name"] for f in bd.todos(
            "SELECT column_name FROM information_schema.columns WHERE table_name = ?", (tabla,))}
    return {f["name"] for f in bd.todos("PRAGMA table_info(%s)" % tabla)}


def migrar(bd):
    version = 0 if ES_PG else bd.valor("PRAGMA user_version")
    if not ES_PG and version >= VERSION_BD:
        return
    # La tabla de sesiones antigua (token, usuario_id, expira) se reemplaza: solo obliga a volver a entrar.
    if "ultimo_uso" not in _columnas(bd, "sesiones"):
        bd.ejecutar("DROP TABLE sesiones")
        bd.ejecutar("CREATE TABLE sesiones (token TEXT PRIMARY KEY, usuario_id INTEGER NOT NULL, creada TEXT, ultimo_uso TEXT)")
    for tabla, col, tipo in COLUMNAS_NUEVAS:
        if col not in _columnas(bd, tabla):
            bd.ejecutar("ALTER TABLE %s ADD COLUMN %s %s" % (tabla, col, tipo))
    # Completar datos de registros antiguos
    bd.ejecutar("UPDATE entradas SET calidad = 2 WHERE calidad IS NULL")
    bd.ejecutar("UPDATE entradas SET hora = '12:00' WHERE hora IS NULL OR hora = ''")
    bd.ejecutar("UPDATE ventas SET calidad = (SELECT e.calidad FROM entradas e WHERE e.id = ventas.entrada_id)"
                " WHERE calidad IS NULL OR calidad = 2")
    bd.ejecutar("UPDATE ventas SET hora = '12:00' WHERE hora IS NULL OR hora = ''")
    bd.ejecutar("UPDATE salidas SET hora = '12:00' WHERE hora IS NULL OR hora = ''")
    bd.ejecutar("UPDATE salidas SET anulada = 0 WHERE anulada IS NULL")
    vig = int(CONFIG_DEFECTO["vigencia_horas"])
    for s in bd.todos("SELECT id, fecha FROM salidas WHERE emitida IS NULL OR vence IS NULL"):
        em = datetime.strptime(s["fecha"] + " 12:00:00", "%Y-%m-%d %H:%M:%S")
        bd.ejecutar("UPDATE salidas SET emitida = ?, vence = ? WHERE id = ?",
                    (ts(em), ts(em + timedelta(hours=vig)), s["id"]))
    bd.ejecutar("UPDATE usuarios SET debe_cambiar = 0 WHERE debe_cambiar IS NULL")
    bd.ejecutar("UPDATE usuarios SET intentos_fallidos = 0 WHERE intentos_fallidos IS NULL")
    if not ES_PG:
        bd.ejecutar("PRAGMA user_version = %d" % VERSION_BD)
    if version:
        print("Base de datos migrada de la versión %d a la %d sin borrar datos." % (version, VERSION_BD))


def iniciar_bd():
    print("Base de datos: %s" % ("PostgreSQL (" + BD.params["host"] + ")" if ES_PG else "SQLite (" + DB_PATH + ")"))
    with LOCK, BD.sesion() as bd:
        nueva_sqlite = not ES_PG and not bd.todos("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'entradas'")
        for sql in esquema():
            bd.ejecutar(sql)
        if nueva_sqlite:
            bd.ejecutar("PRAGMA user_version = %d" % VERSION_BD)
        else:
            migrar(bd)
        for k, v in CONFIG_DEFECTO.items():
            if bd.valor("SELECT COUNT(*) FROM config WHERE clave = ?", (k,)) == 0:
                bd.ejecutar("INSERT INTO config (clave, valor) VALUES (?, ?)", (k, v))
        crear_admin_inicial(bd)
        if os.environ.get("DATOS_DEMO", "1") != "0" and not bd.valor("SELECT COUNT(*) FROM entradas"):
            print("Base nueva: generando usuarios de prueba y 60 días de datos de ejemplo...")
            generar_datos_ejemplo(bd)


# ===========================================================================
# Configuración editable
# ===========================================================================
def leer_config(bd):
    c = dict(CONFIG_DEFECTO)
    for f in bd.todos("SELECT clave, valor FROM config"):
        c[f["clave"]] = f["valor"]
    return {"calidades": {1: c["calidad_1"], 2: c["calidad_2"], 3: c["calidad_3"]},
            "libras_por_taque": float(c["libras_por_taque"]), "vigencia_horas": int(float(c["vigencia_horas"]))}


def nombre_calidad(cfg, n):
    return cfg["calidades"].get(int(n or 2), "?")


# ===========================================================================
# Usuarios, contraseñas, sesiones y bitácora
# ===========================================================================
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


def firma(u):
    return "%s (%s)" % (u["nombre"], u["usuario"])


def bitacora(bd, usr, accion, detalle="", ip=""):
    bd.ejecutar("INSERT INTO bitacora (fecha_hora, usuario_id, usuario, accion, detalle, ip) VALUES (?,?,?,?,?,?)",
                (ts(ahora()), usr.get("id") if usr else None, (usr or {}).get("usuario") or "", accion,
                 str(detalle)[:500], ip or ""))


def crear_admin_inicial(bd):
    if bd.valor("SELECT COUNT(*) FROM usuarios"):
        return
    clave_env = os.environ.get("ADMIN_CLAVE", "")
    clave = clave_env or "admin123"
    bd.insertar("INSERT INTO usuarios (usuario, nombre, clave, rol, mercado, activo, debe_cambiar, intentos_fallidos, creado)"
                " VALUES (?,?,?,?,?,1,?,0,?)",
                ("admin", "Gerente General", hash_clave(clave), "admin", None, 0 if clave_env else 1, ts(ahora())))
    print("*" * 60)
    print(" Usuario administrador creado: admin")
    if not clave_env:
        print(" Contraseña inicial: admin123  (se pedirá cambiarla al ingresar)")
    print("*" * 60)


def publico(u):
    return {"id": u["id"], "usuario": u["usuario"], "nombre": u["nombre"], "rol": u["rol"],
            "rol_nombre": ROLES.get(u["rol"], u["rol"]), "mercado": u.get("mercado"),
            "debe_cambiar": bool(u.get("debe_cambiar"))}


def _hash_token(token):
    return hashlib.sha256(token.encode()).hexdigest()


def usuario_de_token(token):
    """Devuelve (usuario, motivo). motivo = 'inactividad' si la sesión venció por falta de uso."""
    if not token:
        return None, None
    th = _hash_token(token)
    with BD.sesion() as bd:
        u = bd.uno("""SELECT u.*, s.ultimo_uso FROM sesiones s JOIN usuarios u ON u.id = s.usuario_id
                      WHERE s.token = ?""", (th,))
    if not u:
        return None, None
    n = ahora()
    if not u["activo"] or not u["ultimo_uso"] or u["ultimo_uso"] < ts(n - INACTIVIDAD):
        with LOCK, BD.sesion() as bd:
            bd.ejecutar("DELETE FROM sesiones WHERE token = ?", (th,))
            if u["activo"]:
                bitacora(bd, u, "SESION_VENCIDA", "Cerrada por 30 minutos sin uso")
        return None, ("inactividad" if u["activo"] else None)
    if u["ultimo_uso"] < ts(n - timedelta(seconds=30)):
        with LOCK, BD.sesion() as bd:
            bd.ejecutar("UPDATE sesiones SET ultimo_uso = ? WHERE token = ?", (ts(n), th))
    return u, None


def login(datos, ip):
    usuario = str(datos.get("usuario") or "").strip().lower()[:40]
    clave = str(datos.get("clave") or "")
    if not usuario or not clave:
        return 400, {"errores": ["Ingrese usuario y contraseña."]}, None
    with LOCK, BD.sesion() as bd:
        u = bd.uno("SELECT * FROM usuarios WHERE usuario = ?", (usuario,))
        n = ahora()
        if u and u["bloqueado_hasta"] and u["bloqueado_hasta"] > ts(n):
            falta = datetime.strptime(u["bloqueado_hasta"], "%Y-%m-%d %H:%M:%S") - n
            minutos = max(1, math.ceil(falta.total_seconds() / 60))
            bitacora(bd, u, "LOGIN_BLOQUEADO", "Intento durante el bloqueo", ip)
            return 429, {"errores": ["Usuario bloqueado temporalmente por %d intentos fallidos. "
                                     "Intente de nuevo en %d minuto(s)." % (MAX_INTENTOS, minutos)]}, None
        if not u or not u["activo"] or not verificar_clave(clave, u["clave"]):
            if u:
                intentos = (u["intentos_fallidos"] or 0) + 1
                if intentos >= MAX_INTENTOS:
                    bd.ejecutar("UPDATE usuarios SET intentos_fallidos = 0, bloqueado_hasta = ? WHERE id = ?",
                                (ts(n + TIEMPO_BLOQUEO), u["id"]))
                    bitacora(bd, u, "USUARIO_BLOQUEADO", "%d intentos fallidos seguidos: bloqueo de 5 minutos" % MAX_INTENTOS, ip)
                else:
                    bd.ejecutar("UPDATE usuarios SET intentos_fallidos = ? WHERE id = ?", (intentos, u["id"]))
            bitacora(bd, u or {"usuario": usuario}, "LOGIN_FALLIDO",
                     "Usuario o contraseña incorrectos" if u else "Usuario inexistente: %s" % usuario, ip)
            return 401, {"errores": ["Usuario o contraseña incorrectos."]}, None
        token = secrets.token_urlsafe(32)
        bd.ejecutar("UPDATE usuarios SET intentos_fallidos = 0, bloqueado_hasta = NULL WHERE id = ?", (u["id"],))
        bd.ejecutar("DELETE FROM sesiones WHERE ultimo_uso < ?", (ts(n - INACTIVIDAD),))
        bd.ejecutar("INSERT INTO sesiones (token, usuario_id, creada, ultimo_uso) VALUES (?,?,?,?)",
                    (_hash_token(token), u["id"], ts(n), ts(n)))
        bitacora(bd, u, "LOGIN", "Inicio de sesión", ip)
    return 200, {"ok": True, "usuario": publico(u)}, token


def logout(token, usr, ip):
    if token:
        with LOCK, BD.sesion() as bd:
            bd.ejecutar("DELETE FROM sesiones WHERE token = ?", (_hash_token(token),))
            if usr:
                bitacora(bd, usr, "LOGOUT", "Cierre de sesión", ip)


# ===========================================================================
# Utilidades de validación
# ===========================================================================
def _texto(d, campo, largo=120):
    v = d.get(campo)
    return "" if v is None else str(v).strip()[:largo]


def _numero(d, campo, nombre, errores, maximo=1000000):
    v = d.get(campo)
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
    if n > maximo:
        errores.append("«%s» es demasiado grande." % nombre)
        return None
    return round(n, 2)


def _obligatorio(d, campo, nombre, errores, largo=120):
    v = _texto(d, campo, largo)
    if not v:
        errores.append("El campo «%s» es obligatorio." % nombre)
    return v


def _ci(d, campo, nombre, errores):
    v = _texto(d, campo, 20).upper()
    if not v:
        errores.append("El campo «%s» es obligatorio." % nombre)
    elif not RE_CI.match(v):
        errores.append("%s inválido: debe tener de 5 a 10 dígitos, con complemento opcional (ej. 1234567-1A)." % nombre)
    return v


def _n(x):
    """Número con formato boliviano para mensajes: 1.250,5"""
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


def _bs(x):
    return "Bs " + _n(round(x, 2))


class Error(Exception):
    """Error de negocio que se devuelve como JSON."""

    def __init__(self, codigo, errores):
        super().__init__(errores)
        self.codigo, self.errores = codigo, errores if isinstance(errores, list) else [errores]


def mercado_alcance(usr, pedido=""):
    """El operador SOLO trabaja con su mercado; los demás pueden elegir (o ver todos)."""
    if usr["rol"] == "operador":
        if not usr.get("mercado"):
            raise Error(403, "Su usuario no tiene un mercado asignado. Consulte al administrador.")
        return usr["mercado"]
    if pedido and pedido not in MERCADOS:
        raise Error(400, "Mercado no válido.")
    return pedido or ""


# ===========================================================================
# Precio de referencia (promedio ponderado del día por calidad)
# ===========================================================================
def precio_referencia(bd, mercado, calidad):
    cond = " FROM ventas v JOIN entradas e ON e.id = v.entrada_id WHERE v.calidad = ?"
    par = [int(calidad)]
    if mercado:
        cond += " AND e.mercado = ?"
        par.append(mercado)
    hoy_s = hoy().isoformat()
    r = bd.uno("SELECT SUM(v.total) AS t, SUM(v.libras) AS lb" + cond + " AND v.fecha = ?", par + [hoy_s])
    if r and r["lb"]:
        return {"precio": round(r["t"] / r["lb"], 2), "fecha": hoy_s, "es_hoy": True, "libras": round(r["lb"], 2)}
    ultima = bd.valor("SELECT MAX(v.fecha)" + cond, par)
    if not ultima:
        return {"precio": None, "fecha": None, "es_hoy": False, "libras": 0}
    r = bd.uno("SELECT SUM(v.total) AS t, SUM(v.libras) AS lb" + cond + " AND v.fecha = ?", par + [ultima])
    return {"precio": round(r["t"] / r["lb"], 2), "fecha": ultima, "es_hoy": False, "libras": round(r["lb"], 2)}


def _precio_en_fecha(bd, mercado, calidad, fecha):
    r = bd.uno("SELECT SUM(v.total) AS t, SUM(v.libras) AS lb FROM ventas v JOIN entradas e ON e.id = v.entrada_id"
               " WHERE v.calidad = ? AND e.mercado = ? AND v.fecha = ?", (calidad, mercado, fecha))
    return round(r["t"] / r["lb"], 2) if r and r["lb"] else None


# ===========================================================================
# Página pública (sin iniciar sesión)
# ===========================================================================
CONSULTAS_FALLIDAS = {}      # ip -> [instantes de consultas fallidas]
MAX_CONSULTAS_FALLIDAS = 10  # por IP cada 15 minutos (evita adivinar CIs)


def precios_publicos(ctx):
    """Precio promedio por libra de hoy (o del último día con ventas) por mercado y calidad."""
    with BD.sesion() as bd:
        cfg = leer_config(bd)
        mercados = []
        for m in MERCADOS:
            calidades = []
            for c in (1, 2, 3):
                ref = precio_referencia(bd, m, c)
                anterior, serie = None, []
                if ref["fecha"]:
                    previo = bd.valor("SELECT MAX(v.fecha) FROM ventas v JOIN entradas e ON e.id = v.entrada_id"
                                      " WHERE v.calidad = ? AND e.mercado = ? AND v.fecha < ?", (c, m, ref["fecha"]))
                    anterior = _precio_en_fecha(bd, m, c, previo) if previo else None
                    filas = bd.todos("SELECT v.fecha AS f, SUM(v.total) AS t, SUM(v.libras) AS lb FROM ventas v"
                                     " JOIN entradas e ON e.id = v.entrada_id WHERE v.calidad = ? AND e.mercado = ?"
                                     " AND v.fecha <= ? GROUP BY v.fecha ORDER BY v.fecha DESC LIMIT 14", (c, m, ref["fecha"]))
                    serie = [{"fecha": f["f"], "precio": round(f["t"] / f["lb"], 2)} for f in reversed(filas) if f["lb"]]
                variacion = round((ref["precio"] - anterior) * 100 / anterior, 1) if ref["precio"] and anterior else None
                calidades.append(dict(ref, calidad=c, nombre=cfg["calidades"][c], anterior=anterior,
                                      variacion=variacion, serie=serie))
            mercados.append({"mercado": m, "calidades": calidades})
    return 200, {"hoy": hoy().isoformat(), "ahora": ts(ahora()), "mercados": mercados}


def consultar_hoja_publica(ctx):
    """El comprador consulta su hoja de ruta con el código y su CI."""
    ip, momento = ctx.ip, time.time()
    fallos = [t for t in CONSULTAS_FALLIDAS.get(ip, []) if momento - t < 900]
    CONSULTAS_FALLIDAS[ip] = fallos
    if len(fallos) >= MAX_CONSULTAS_FALLIDAS:
        raise Error(429, "Demasiadas consultas sin resultado. Espere 15 minutos e intente de nuevo.")
    codigo = re.sub(r"\s", "", _texto(ctx.datos, "codigo", 40).upper())
    ci = re.sub(r"\s", "", _texto(ctx.datos, "ci", 20).upper())
    errores = []
    if not codigo:
        errores.append("Escriba el código de su hoja de ruta (ej. HR-2026-000001).")
    if not ci:
        errores.append("Escriba su CI.")
    elif not RE_CI.match(ci):
        errores.append("CI inválido: de 5 a 10 dígitos, con complemento opcional (ej. 1234567-1A).")
    if errores:
        raise Error(400, errores)
    with LOCK, BD.sesion() as bd:
        s = bd.uno(SQL_SALIDAS + " WHERE s.hoja_ruta = ?", (codigo,))
        encontrada = bool(s) and (s["ci_comprador"] or "").upper() == ci
        if encontrada:
            bitacora(bd, None, "CONSULTA_PUBLICA", "El comprador consultó la hoja de ruta %s" % codigo, ip)
        else:
            bitacora(bd, None, "CONSULTA_PUBLICA_FALLIDA", "Código %s con CI %s: sin coincidencia" % (codigo, ci), ip)
        cfg = leer_config(bd)
    if not encontrada:  # el error se lanza fuera de la transacción para que el registro quede guardado
        fallos.append(momento)
        raise Error(404, "No encontramos una hoja de ruta con ese código y CI. Revise los datos e intente de nuevo.")
    estado = estado_hoja(s)
    datos = {k: s[k] for k in ("hoja_ruta", "emitida", "vence", "departamento", "libras", "calidad", "placa",
                               "transportista", "ci_transportista", "comprador", "mercado", "procedencia")}
    datos.update(estado=estado, calidad_nombre=nombre_calidad(cfg, s["calidad"]),
                 motivo_anulacion=s["motivo_anulacion"] if estado == "ANULADA" else None, ahora=ts(ahora()))
    return 200, datos


# ===========================================================================
# Saldos y hojas de ruta
# ===========================================================================
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


def estado_hoja(s, ahora_s=None):
    ahora_s = ahora_s or ts(ahora())
    if s.get("anulada"):
        return "ANULADA"
    if s.get("vence") and s["vence"] < ahora_s:
        return "VENCIDA"
    return "VIGENTE"


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
SELECT s.*, v.comprador, v.ci_comprador, v.fecha AS fecha_venta, v.precio_libra, v.calidad,
       e.id AS entrada_id, e.mercado, e.procedencia, e.productor, e.ci AS ci_productor, e.fecha AS fecha_entrada,
       (SELECT COUNT(*) FROM verificaciones x WHERE x.codigo = s.hoja_ruta) AS verificaciones
FROM salidas s JOIN ventas v ON v.id = s.venta_id JOIN entradas e ON e.id = v.entrada_id
"""


def _con_estado(filas):
    a = ts(ahora())
    for f in filas:
        f["estado"] = estado_hoja(f, a)
    return filas


# ===========================================================================
# Registro de movimientos
# ===========================================================================
def crear_entrada(ctx):
    d, usr, errores, avisos = ctx.datos, ctx.usr, [], []
    mercado = mercado_alcance(usr, _texto(d, "mercado"))
    if not mercado:
        errores.append("El campo «Mercado» es obligatorio.")
    procedencia = _obligatorio(d, "procedencia", "Procedencia", errores)
    if mercado and procedencia and procedencia not in MERCADOS[mercado]:
        errores.append("La procedencia «%s» no corresponde al mercado %s." % (procedencia, mercado))
    productor = _obligatorio(d, "productor", "Productor", errores)
    ci = _ci(d, "ci", "CI del productor", errores)
    telefono = _texto(d, "telefono", 20)
    if telefono and not RE_TELEFONO.match(telefono):
        errores.append("El teléfono no es válido (solo números, de 7 a 15 caracteres).")
    try:
        calidad = int(d.get("calidad") or 0)
    except (TypeError, ValueError):
        calidad = 0
    if calidad not in (1, 2, 3):
        errores.append("Elija la calidad de la hoja.")
    taques = _numero(d, "taques", "Taques", errores, 1000)
    libras = _numero(d, "libras", "Libras", errores, 100000)
    observacion = _texto(d, "observacion", 500)
    with LOCK, BD.sesion() as bd:
        cfg = leer_config(bd)
        if taques and libras:
            esperado = taques * cfg["libras_por_taque"]
            if libras > esperado * 2 or libras < esperado * 0.3:
                errores.append("El peso (%s lb) no es razonable para %s taques (se esperan unas %s lb)."
                               % (_n(libras), _n(taques), _n(esperado)))
            elif abs(libras - esperado) > esperado * TOLERANCIA_PESO:
                avisos.append("Atención: %s lb se aleja más del 20%% de lo esperado para %s taques (%s lb)."
                              % (_n(libras), _n(taques), _n(esperado)))
        if errores:
            raise Error(400, errores)
        n = ahora()
        nid = bd.insertar(
            "INSERT INTO entradas (fecha, hora, mercado, productor, ci, telefono, procedencia, calidad, taques, libras,"
            " observacion, usuario_id, registrado_por) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (n.date().isoformat(), n.strftime("%H:%M"), mercado, productor, ci, telefono, procedencia, calidad,
             taques, libras, observacion, usr["id"], firma(usr)))
        bitacora(bd, usr, "ENTRADA", "Entrada Nº %d: %s lb (%s) de %s, %s" % (
            nid, _n(libras), nombre_calidad(cfg, calidad), productor, mercado), ctx.ip)
    return 201, {"ok": True, "id": nid, "avisos": avisos, "mensaje": "Entrada Nº %d registrada." % nid}


def crear_venta(ctx):
    d, usr, errores, avisos = ctx.datos, ctx.usr, [], []
    entrada_id = _texto(d, "entrada_id")
    if not entrada_id:
        errores.append("Debe elegir la entrada (lote) que se vende.")
    elif not entrada_id.isdigit():
        errores.append("La entrada elegida no es válida.")
    comprador = _obligatorio(d, "comprador", "Comprador", errores)
    ci = _ci(d, "ci_comprador", "CI del comprador", errores)
    libras = _numero(d, "libras", "Libras", errores, 100000)
    precio = _numero(d, "precio_libra", "Precio acordado por libra", errores, 10000)
    if errores:
        raise Error(400, errores)
    with LOCK, BD.sesion() as bd:
        ent = bd.uno("SELECT * FROM entradas WHERE id = ?", (int(entrada_id),))
        if ent is None:
            raise Error(400, "La entrada Nº %s no existe." % entrada_id)
        alcance = mercado_alcance(usr)
        if alcance and ent["mercado"] != alcance:
            raise Error(403, "La entrada Nº %d pertenece a otro mercado; no puede venderla." % ent["id"])
        saldo = saldo_entrada(bd, ent["id"])
        if libras > saldo + 1e-9:
            raise Error(400, "La venta (%s lb) supera lo que queda sin vender de la entrada Nº %d (%s lb)."
                        % (_n(libras), ent["id"], _n(saldo)))
        cfg = leer_config(bd)
        calidad = int(ent["calidad"] or 2)
        ref = precio_referencia(bd, ent["mercado"], calidad)
        if ref["precio"]:
            dif = (precio - ref["precio"]) / ref["precio"]
            if abs(dif) > TOLERANCIA_PRECIO:
                avisos.append("El precio acordado (%s) está %s%% %s del precio de referencia de la calidad %s (%s, %s)."
                              % (_bs(precio), _n(round(abs(dif) * 100)), "por encima" if dif > 0 else "por debajo",
                                 nombre_calidad(cfg, calidad), _bs(ref["precio"]),
                                 "hoy" if ref["es_hoy"] else "del " + ref["fecha"]))
        n = ahora()
        total = round(libras * precio, 2)
        nid = bd.insertar(
            "INSERT INTO ventas (fecha, hora, entrada_id, comprador, ci_comprador, libras, precio_libra, total, calidad,"
            " usuario_id, registrado_por) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
            (n.date().isoformat(), n.strftime("%H:%M"), ent["id"], comprador, ci, libras, precio, total, calidad,
             usr["id"], firma(usr)))
        bitacora(bd, usr, "VENTA", "Venta Nº %d: %s lb a %s/lb = %s, comprador %s" % (
            nid, _n(libras), _bs(precio), _bs(total), comprador), ctx.ip)
    return 201, {"ok": True, "id": nid, "total": total, "avisos": avisos, "referencia": ref,
                 "mensaje": "Venta Nº %d registrada." % nid}


def crear_salida(ctx):
    d, usr, errores = ctx.datos, ctx.usr, []
    venta_id = _texto(d, "venta_id")
    if not venta_id:
        errores.append("Debe elegir la venta que se despacha.")
    elif not venta_id.isdigit():
        errores.append("La venta elegida no es válida.")
    departamento = _obligatorio(d, "departamento", "Departamento de destino", errores)
    if departamento and departamento not in DEPARTAMENTOS:
        errores.append("El departamento «%s» no es válido." % departamento)
    libras = _numero(d, "libras", "Libras", errores, 100000)
    transportista = _obligatorio(d, "transportista", "Transportista", errores)
    ci_t = _ci(d, "ci_transportista", "CI del transportista", errores)
    placa = re.sub(r"[\s\-]", "", _texto(d, "placa", 20).upper())
    if placa and not RE_PLACA.match(placa):
        errores.append("La placa no es válida: 3 o 4 dígitos y 3 letras (ej. 2345ABC).")
    if errores:
        raise Error(400, errores)
    with LOCK, BD.sesion() as bd:
        ven = bd.uno("SELECT v.*, e.mercado FROM ventas v JOIN entradas e ON e.id = v.entrada_id WHERE v.id = ?",
                     (int(venta_id),))
        if ven is None:
            raise Error(400, "La venta Nº %s no existe." % venta_id)
        alcance = mercado_alcance(usr)
        if alcance and ven["mercado"] != alcance:
            raise Error(403, "La venta Nº %d pertenece a otro mercado; no puede despacharla." % ven["id"])
        saldo = saldo_venta(bd, ven["id"])
        if libras > saldo + 1e-9:
            raise Error(400, "La salida (%s lb) supera lo vendido que aún está en el galpón para la venta Nº %d (%s lb)."
                        % (_n(libras), ven["id"], _n(saldo)))
        cfg = leer_config(bd)
        n = ahora()
        codigo = siguiente_hoja_ruta(bd, n.year)
        vence = n + timedelta(hours=cfg["vigencia_horas"])
        nid = bd.insertar(
            "INSERT INTO salidas (fecha, hora, venta_id, departamento, libras, hoja_ruta, transportista, ci_transportista,"
            " placa, emitida, vence, anulada, usuario_id, registrado_por) VALUES (?,?,?,?,?,?,?,?,?,?,?,0,?,?)",
            (n.date().isoformat(), n.strftime("%H:%M"), ven["id"], departamento, libras, codigo, transportista, ci_t,
             placa, ts(n), ts(vence), usr["id"], firma(usr)))
        bitacora(bd, usr, "SALIDA", "Hoja de ruta %s: %s lb a %s, transportista %s, placa %s" % (
            codigo, _n(libras), departamento, transportista, placa or "-"), ctx.ip)
    return 201, {"ok": True, "id": nid, "hoja_ruta": codigo, "vence": ts(vence), "avisos": [],
                 "mensaje": "Salida registrada con hoja de ruta %s." % codigo}


def anular_hoja(ctx):
    codigo = unquote(ctx.m.group(1)).upper()
    motivo = _texto(ctx.datos, "motivo", 300)
    if len(motivo) < 5:
        raise Error(400, "Escriba el motivo de la anulación (al menos 5 caracteres).")
    with LOCK, BD.sesion() as bd:
        s = bd.uno("SELECT * FROM salidas WHERE hoja_ruta = ?", (codigo,))
        if not s:
            raise Error(404, "La hoja de ruta %s no existe." % codigo)
        if s["anulada"]:
            raise Error(400, "La hoja de ruta %s ya estaba anulada." % codigo)
        bd.ejecutar("UPDATE salidas SET anulada = 1, motivo_anulacion = ?, anulada_por = ?, anulada_en = ? WHERE id = ?",
                    (motivo, firma(ctx.usr), ts(ahora()), s["id"]))
        bitacora(bd, ctx.usr, "ANULACION", "Hoja de ruta %s anulada. Motivo: %s" % (codigo, motivo), ctx.ip)
    return 200, {"ok": True, "mensaje": "Hoja de ruta %s anulada." % codigo}


# ===========================================================================
# Verificación en la tranca
# ===========================================================================
MOTIVOS = {"VALIDA": "Hoja de ruta vigente emitida por el sistema.",
           "VENCIDA": "La hoja de ruta está VENCIDA: su plazo de vigencia terminó.",
           "ANULADA": "La hoja de ruta fue ANULADA por la administración.",
           "NO_EXISTE": "El código no corresponde a ninguna hoja de ruta emitida por el sistema."}


def verificar(ctx):
    codigo = _texto(ctx.datos, "codigo", 40).upper()
    puesto = _texto(ctx.datos, "puesto", 80)
    if not codigo:
        raise Error(400, "Ingrese el código de la hoja de ruta.")
    with LOCK, BD.sesion() as bd:
        s = bd.uno(SQL_SALIDAS + " WHERE s.hoja_ruta = ?", (codigo,))
        if not s:
            resultado = "NO_EXISTE"
        else:
            resultado = {"VIGENTE": "VALIDA"}.get(estado_hoja(s), estado_hoja(s))
        bd.ejecutar("INSERT INTO verificaciones (codigo, fecha_hora, usuario_id, usuario, resultado, puesto)"
                    " VALUES (?,?,?,?,?,?)", (codigo, ts(ahora()), ctx.usr["id"], ctx.usr["usuario"], resultado, puesto))
        bitacora(bd, ctx.usr, "VERIFICACION", "%s → %s%s" % (codigo, resultado, (" en " + puesto) if puesto else ""), ctx.ip)
        cfg = leer_config(bd)
    hoja = None
    if s:
        s["estado"] = estado_hoja(s)
        s["calidad_nombre"] = nombre_calidad(cfg, s["calidad"])
        hoja = {k: s[k] for k in ("hoja_ruta", "fecha", "hora", "emitida", "vence", "departamento", "libras",
                                  "calidad", "calidad_nombre", "transportista", "ci_transportista", "placa",
                                  "comprador", "ci_comprador", "mercado", "procedencia", "productor", "estado",
                                  "motivo_anulacion", "anulada_en", "verificaciones")}
        hoja["verificaciones"] = (hoja["verificaciones"] or 0) + 1
    return 200, {"resultado": resultado, "valida": resultado == "VALIDA", "motivo": MOTIVOS[resultado],
                 "codigo": codigo, "hoja": hoja}


# ===========================================================================
# Consultas
# ===========================================================================
def _filtros(qs, col_fecha, mercado):
    cond, par = [], []
    if qs.get("desde") and RE_FECHA.match(qs["desde"]):
        cond.append(col_fecha + " >= ?")
        par.append(qs["desde"])
    if qs.get("hasta") and RE_FECHA.match(qs["hasta"]):
        cond.append(col_fecha + " <= ?")
        par.append(qs["hasta"])
    if mercado:
        cond.append("e.mercado = ?")
        par.append(mercado)
    if qs.get("calidad") in ("1", "2", "3"):
        cond.append("e.calidad = ?")
        par.append(int(qs["calidad"]))
    return cond, par


def _where(cond):
    return (" WHERE " + " AND ".join(cond)) if cond else ""


def listar_entradas(ctx):
    qs = ctx.qs
    cond, par = [], []
    mercado = mercado_alcance(ctx.usr, qs.get("mercado", ""))
    if mercado:
        cond.append("mercado = ?")
        par.append(mercado)
    q = qs.get("q", "").strip()
    if q:
        cond.append("(productor {0} ? OR ci {0} ? OR procedencia {0} ? OR CAST(id AS TEXT) = ?)".format(LIKE()))
        par += ["%" + q + "%"] * 3 + [q.lstrip("#")]
    if qs.get("con_saldo") == "1":
        cond.append("saldo > 0.004")
    with BD.sesion() as bd:
        return 200, bd.todos(SQL_ENTRADAS + _where(cond) + " ORDER BY fecha DESC, id DESC LIMIT 500", par)


def listar_ventas(ctx):
    qs = ctx.qs
    cond, par = [], []
    mercado = mercado_alcance(ctx.usr, qs.get("mercado", ""))
    if mercado:
        cond.append("mercado = ?")
        par.append(mercado)
    q = qs.get("q", "").strip()
    if q:
        cond.append("(comprador {0} ? OR ci_comprador {0} ? OR productor {0} ? OR CAST(id AS TEXT) = ?)".format(LIKE()))
        par += ["%" + q + "%"] * 3 + [q.lstrip("#")]
    if qs.get("con_saldo") == "1":
        cond.append("saldo > 0.004")
    with BD.sesion() as bd:
        return 200, bd.todos(SQL_VENTAS + _where(cond) + " ORDER BY fecha DESC, id DESC LIMIT 500", par)


def _consulta_salidas(ctx, limite=500):
    qs = ctx.qs
    mercado = mercado_alcance(ctx.usr, qs.get("mercado", ""))
    cond, par = _filtros(qs, "s.fecha", mercado)
    if qs.get("departamento") in DEPARTAMENTOS:
        cond.append("s.departamento = ?")
        par.append(qs["departamento"])
    q = qs.get("q", "").strip()
    if q:
        cond.append("(s.hoja_ruta {0} ? OR s.placa {0} ? OR v.comprador {0} ? OR s.transportista {0} ?)".format(LIKE()))
        par += ["%" + q + "%"] * 4
    a = ts(ahora())
    est = qs.get("estado", "")
    if est == "ANULADA":
        cond.append("s.anulada = 1")
    elif est == "VENCIDA":
        cond.append("s.anulada = 0 AND s.vence < ?")
        par.append(a)
    elif est == "VIGENTE":
        cond.append("s.anulada = 0 AND s.vence >= ?")
        par.append(a)
    sql = SQL_SALIDAS + _where(cond) + " ORDER BY s.id DESC" + (" LIMIT %d" % limite if limite else "")
    with BD.sesion() as bd:
        return _con_estado(bd.todos(sql, par))


def listar_salidas(ctx):
    return 200, _consulta_salidas(ctx)


def ver_hoja(ctx):
    codigo = unquote(ctx.m.group(1)).upper()[:40]
    with BD.sesion() as bd:
        s = bd.uno(SQL_SALIDAS + " WHERE s.hoja_ruta = ?", (codigo,))
        cfg = leer_config(bd)
        verifs = bd.todos("SELECT fecha_hora, usuario, resultado, puesto FROM verificaciones WHERE codigo = ?"
                          " ORDER BY id DESC LIMIT 20", (codigo,)) if s else []
    if not s:
        raise Error(404, "La hoja de ruta «%s» no existe." % codigo)
    alcance = mercado_alcance(ctx.usr)
    if alcance and s["mercado"] != alcance:
        raise Error(403, "Esta hoja de ruta pertenece a otro mercado.")
    s["estado"] = estado_hoja(s)
    s["calidad_nombre"] = nombre_calidad(cfg, s["calidad"])
    s["historial"] = verifs
    return 200, s


def ref_precio(ctx):
    mercado = mercado_alcance(ctx.usr, ctx.qs.get("mercado", ""))
    cal = ctx.qs.get("calidad", "2")
    if cal not in ("1", "2", "3"):
        raise Error(400, "Calidad no válida.")
    with BD.sesion() as bd:
        return 200, precio_referencia(bd, mercado, int(cal))


def resumen(ctx):
    qs = ctx.qs
    mercado = mercado_alcance(ctx.usr, qs.get("mercado", ""))
    ce, pe = _filtros(qs, "e.fecha", mercado)
    cv, pv = _filtros(qs, "v.fecha", mercado)
    cs, ps = _filtros(qs, "s.fecha", mercado)
    FROM_V = " FROM ventas v JOIN entradas e ON e.id = v.entrada_id"
    FROM_S = " FROM salidas s JOIN ventas v ON v.id = s.venta_id JOIN entradas e ON e.id = v.entrada_id"
    a = ts(ahora())
    with BD.sesion() as bd:
        cfg = leer_config(bd)
        r = bd.uno("SELECT COUNT(*) AS n, COALESCE(SUM(libras),0) AS lb, COALESCE(SUM(taques),0) AS tq FROM entradas e"
                   + _where(ce), pe)
        entradas = {"cantidad": r["n"], "libras": round(r["lb"], 2), "taques": round(r["tq"], 2)}
        r = bd.uno("SELECT COUNT(*) AS n, COALESCE(SUM(v.libras),0) AS lb, COALESCE(SUM(v.total),0) AS m" + FROM_V
                   + _where(cv), pv)
        ventas = {"cantidad": r["n"], "libras": round(r["lb"], 2), "monto": round(r["m"], 2)}
        r = bd.uno("SELECT COUNT(*) AS n, COALESCE(SUM(s.libras),0) AS lb" + FROM_S + _where(cs), ps)
        salidas = {"cantidad": r["n"], "libras": round(r["lb"], 2), "hojas_ruta": r["n"]}
        precio_promedio = round(ventas["monto"] / ventas["libras"], 2) if ventas["libras"] else 0

        cm, pm = (" WHERE mercado = ?", [mercado]) if mercado else ("", [])
        sin_vender = bd.valor("SELECT COALESCE(SUM(saldo),0) FROM (" + SQL_ENTRADAS + cm + ") x", pm)
        sin_salir = bd.valor("SELECT COALESCE(SUM(saldo),0) FROM (" + SQL_VENTAS + cm + ") x", pm)
        inventario = {"sin_vender": round(sin_vender, 2), "vendida_sin_salir": round(sin_salir, 2),
                      "total_en_mercado": round(sin_vender + sin_salir, 2),
                      "taques_equivalentes": round((sin_vender + sin_salir) / cfg["libras_por_taque"], 1)}

        datos = {f["d"]: (f["lb"], f["n"]) for f in bd.todos(
            "SELECT s.departamento AS d, SUM(s.libras) AS lb, COUNT(*) AS n" + FROM_S + _where(cs)
            + " GROUP BY s.departamento", ps)}
        total_s = sum(v[0] for v in datos.values()) or 0
        por_departamento = sorted([{"departamento": d, "libras": round(datos.get(d, (0, 0))[0], 2),
                                    "hojas_ruta": datos.get(d, (0, 0))[1],
                                    "porcentaje": round(datos.get(d, (0, 0))[0] * 100 / total_s, 2) if total_s else 0}
                                   for d in DEPARTAMENTOS], key=lambda x: -x["libras"])

        por_procedencia = [{"mercado": f["m"], "procedencia": f["p"], "entradas": f["n"], "libras": round(f["lb"], 2),
                            "taques": round(f["tq"], 2),
                            "porcentaje": round(f["lb"] * 100 / entradas["libras"], 2) if entradas["libras"] else 0}
                           for f in bd.todos("SELECT e.mercado AS m, e.procedencia AS p, COUNT(*) AS n, SUM(e.libras) AS lb,"
                                             " SUM(e.taques) AS tq FROM entradas e" + _where(ce)
                                             + " GROUP BY e.mercado, e.procedencia ORDER BY SUM(e.libras) DESC", pe)]

        # Por calidad: entradas (por la calidad de la entrada) y ventas (por la calidad vendida)
        pc = {c: {"calidad": c, "nombre": cfg["calidades"][c], "entradas_lb": 0, "entradas_n": 0,
                  "ventas_lb": 0, "monto": 0, "precio_promedio": 0} for c in (1, 2, 3)}
        for f in bd.todos("SELECT e.calidad AS c, SUM(e.libras) AS lb, COUNT(*) AS n FROM entradas e" + _where(ce)
                          + " GROUP BY e.calidad", pe):
            if f["c"] in pc:
                pc[f["c"]].update(entradas_lb=round(f["lb"], 2), entradas_n=f["n"])
        for f in bd.todos("SELECT v.calidad AS c, SUM(v.libras) AS lb, SUM(v.total) AS t" + FROM_V + _where(cv)
                          + " GROUP BY v.calidad", pv):
            if f["c"] in pc:
                pc[f["c"]].update(ventas_lb=round(f["lb"], 2), monto=round(f["t"], 2),
                                  precio_promedio=round(f["t"] / f["lb"], 2) if f["lb"] else 0)
        por_calidad = list(pc.values())

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
        por_mes = [{"mes": m, "entradas_lb": x.get("entradas_lb", 0), "entradas_n": x.get("entradas_n", 0),
                    "ventas_lb": x.get("ventas_lb", 0), "monto": x.get("monto", 0),
                    "salidas_lb": x.get("salidas_lb", 0), "hojas_ruta": x.get("hojas_ruta", 0)}
                   for m, x in sorted(meses.items())]

        # Serie diaria (últimos 30 días hasta 'hasta' u hoy)
        try:
            fin = datetime.strptime(qs.get("hasta", ""), "%Y-%m-%d").date()
        except ValueError:
            fin = hoy()
        ini = fin - timedelta(days=29)
        qd = dict(qs, desde=ini.isoformat(), hasta=fin.isoformat())
        cd, pd = _filtros(qd, "e.fecha", mercado)
        dias = {f["f"]: (f["lb"], f["n"]) for f in bd.todos(
            "SELECT e.fecha AS f, SUM(e.libras) AS lb, COUNT(*) AS n FROM entradas e" + _where(cd)
            + " GROUP BY e.fecha", pd)}
        cds, pds = _filtros(qd, "s.fecha", mercado)
        dias_s = {f["f"]: f["lb"] for f in bd.todos("SELECT s.fecha AS f, SUM(s.libras) AS lb" + FROM_S + _where(cds)
                                                     + " GROUP BY s.fecha", pds)}
        cdv, pdv = _filtros(qd, "v.fecha", mercado)
        precios = {}
        for f in bd.todos("SELECT v.fecha AS f, v.calidad AS c, SUM(v.total) AS t, SUM(v.libras) AS lb" + FROM_V
                          + _where(cdv) + " GROUP BY v.fecha, v.calidad", pdv):
            if f["lb"]:
                precios.setdefault(f["f"], {})[f["c"]] = round(f["t"] / f["lb"], 2)
        por_dia = []
        for i in range(30):
            dd = (ini + timedelta(days=i)).isoformat()
            lb, n = dias.get(dd, (0, 0))
            p = precios.get(dd, {})
            por_dia.append({"fecha": dd, "libras": round(lb, 2), "entradas": n, "salidas_lb": round(dias_s.get(dd, 0), 2),
                            "p1": p.get(1), "p2": p.get(2), "p3": p.get(3)})

        r = bd.uno("SELECT SUM(CASE WHEN s.anulada = 1 THEN 1 ELSE 0 END) AS an,"
                   " SUM(CASE WHEN s.anulada = 0 AND s.vence < ? THEN 1 ELSE 0 END) AS ve,"
                   " SUM(CASE WHEN s.anulada = 0 AND s.vence >= ? THEN 1 ELSE 0 END) AS vi" + FROM_S + _where(cs),
                   [a, a] + ps)
        hojas_estado = {"VIGENTE": int(r["vi"] or 0), "VENCIDA": int(r["ve"] or 0), "ANULADA": int(r["an"] or 0)}

        cvv, pvv = [], []
        if qs.get("desde") and RE_FECHA.match(qs["desde"]):
            cvv.append("x.fecha_hora >= ?")
            pvv.append(qs["desde"])
        if qs.get("hasta") and RE_FECHA.match(qs["hasta"]):
            cvv.append("x.fecha_hora < ?")
            pvv.append(qs["hasta"] + " 99")
        if mercado:
            cvv.append("e.mercado = ?")
            pvv.append(mercado)
        jv = (" FROM verificaciones x LEFT JOIN salidas s ON s.hoja_ruta = x.codigo"
              " LEFT JOIN ventas v ON v.id = s.venta_id LEFT JOIN entradas e ON e.id = v.entrada_id")
        verif = {f["r"]: f["n"] for f in bd.todos("SELECT x.resultado AS r, COUNT(*) AS n" + jv + _where(cvv)
                                                   + " GROUP BY x.resultado", pvv)}
        ultimas_verif = bd.todos("SELECT x.codigo, x.fecha_hora, x.usuario, x.resultado, x.puesto" + jv + _where(cvv)
                                 + " ORDER BY x.id DESC LIMIT 8", pvv)
        ultimas = _con_estado(bd.todos("SELECT s.hoja_ruta, s.fecha, s.departamento, s.libras, s.anulada, s.vence, e.mercado"
                                       + FROM_S + _where(cs) + " ORDER BY s.id DESC LIMIT 6", ps))
        precio_hoy = []
        for c in (1, 2, 3):
            ref = precio_referencia(bd, mercado, c)
            ref.update(calidad=c, nombre=cfg["calidades"][c])
            precio_hoy.append(ref)

    return 200, {"filtros": {k: qs.get(k, "") for k in ("desde", "hasta", "calidad")}, "mercado": mercado,
                 "entradas": entradas, "ventas": ventas, "salidas": salidas, "precio_promedio": precio_promedio,
                 "inventario": inventario, "por_departamento": por_departamento, "por_procedencia": por_procedencia,
                 "por_calidad": por_calidad, "por_mes": por_mes, "por_dia": por_dia, "precio_hoy": precio_hoy,
                 "hojas_estado": hojas_estado,
                 "verificaciones": {"total": sum(verif.values()), "por_resultado": verif, "ultimas": ultimas_verif},
                 "ultimas_salidas": ultimas, "base_datos": "PostgreSQL" if ES_PG else "SQLite"}


# ---- CSV para Excel
def _dec(x):
    return ("%.2f" % (x or 0)).replace(".", ",")


def _csv(filas):
    buf = io.StringIO()
    w = csv.writer(buf, delimiter=";", lineterminator="\r\n")
    for f in filas:
        w.writerow(f)
    return buf.getvalue()


def csv_departamentos(ctx):
    _, r = resumen(ctx)
    filas = [["Departamento", "Libras", "Hojas de ruta", "Porcentaje (%)"]]
    filas += [[d["departamento"], _dec(d["libras"]), d["hojas_ruta"], _dec(d["porcentaje"])] for d in r["por_departamento"]]
    filas.append(["TOTAL", _dec(r["salidas"]["libras"]), r["salidas"]["hojas_ruta"], _dec(100 if r["salidas"]["libras"] else 0)])
    return "csv", "departamentos.csv", _csv(filas)


def csv_calidad(ctx):
    _, r = resumen(ctx)
    filas = [["Calidad", "Libras entradas", "Nº entradas", "Libras vendidas", "Monto vendido (Bs)", "Precio promedio (Bs/lb)"]]
    filas += [[c["nombre"], _dec(c["entradas_lb"]), c["entradas_n"], _dec(c["ventas_lb"]), _dec(c["monto"]),
               _dec(c["precio_promedio"])] for c in r["por_calidad"]]
    filas += [[], ["Precio promedio diario (Bs/lb)"], ["Fecha"] + [c["nombre"] for c in r["por_calidad"]]]
    filas += [[d["fecha"], _dec(d["p1"]) if d["p1"] else "", _dec(d["p2"]) if d["p2"] else "",
               _dec(d["p3"]) if d["p3"] else ""] for d in r["por_dia"]]
    return "csv", "calidad.csv", _csv(filas)


def csv_salidas(ctx):
    with BD.sesion() as bd:
        cfg = leer_config(bd)
    filas = [["Hoja de ruta", "Estado", "Emitida", "Vence", "Departamento", "Libras", "Calidad", "Transportista",
              "CI transportista", "Placa", "Comprador", "CI comprador", "Mercado", "Procedencia", "Productor",
              "Verificaciones", "Registrado por"]]
    for s in _consulta_salidas(ctx, limite=0):
        filas.append([s["hoja_ruta"], s["estado"], s["emitida"], s["vence"], s["departamento"], _dec(s["libras"]),
                      nombre_calidad(cfg, s["calidad"]), s["transportista"], s["ci_transportista"], s["placa"],
                      s["comprador"], s["ci_comprador"], s["mercado"], s["procedencia"], s["productor"],
                      s["verificaciones"], s["registrado_por"]])
    return "csv", "salidas.csv", _csv(filas)


# ===========================================================================
# Administración
# ===========================================================================
def listar_usuarios(ctx):
    with BD.sesion() as bd:
        us = bd.todos("SELECT * FROM usuarios ORDER BY id")
    a = ts(ahora())
    return 200, [dict(publico(u), activo=bool(u["activo"]), creado=u["creado"],
                      bloqueado=bool(u["bloqueado_hasta"] and u["bloqueado_hasta"] > a)) for u in us]


def _validar_rol_mercado(d, errores):
    rol = _texto(d, "rol") or "operador"
    mercado = _texto(d, "mercado") or None
    if rol not in ROLES:
        errores.append("Rol no válido.")
    if rol == "operador":
        if mercado not in MERCADOS:
            errores.append("El operador debe tener un mercado asignado.")
    else:
        mercado = None
    return rol, mercado


def _admins_activos(bd, excepto):
    return bd.valor("SELECT COUNT(*) FROM usuarios WHERE rol = 'admin' AND activo = 1 AND id <> ?", (excepto,))


def crear_usuario(ctx):
    d, errores = ctx.datos, []
    usuario = _texto(d, "usuario", 40).lower()
    nombre = _obligatorio(d, "nombre", "Nombre completo", errores)
    clave = str(d.get("clave") or "")
    if not RE_USUARIO.match(usuario):
        errores.append("El usuario debe tener de 3 a 30 caracteres: minúsculas, números, punto o guion bajo.")
    if len(clave) < 6:
        errores.append("La contraseña inicial debe tener al menos 6 caracteres.")
    rol, mercado = _validar_rol_mercado(d, errores)
    if errores:
        raise Error(400, errores)
    with LOCK, BD.sesion() as bd:
        if bd.valor("SELECT COUNT(*) FROM usuarios WHERE usuario = ?", (usuario,)):
            raise Error(400, "Ya existe el usuario «%s»." % usuario)
        nid = bd.insertar("INSERT INTO usuarios (usuario, nombre, clave, rol, mercado, activo, debe_cambiar,"
                          " intentos_fallidos, creado) VALUES (?,?,?,?,?,1,1,0,?)",
                          (usuario, nombre, hash_clave(clave), rol, mercado, ts(ahora())))
        bitacora(bd, ctx.usr, "USUARIO_CREADO", "%s (%s, %s%s)" % (usuario, nombre, ROLES[rol],
                                                                    ", " + mercado if mercado else ""), ctx.ip)
    return 201, {"ok": True, "id": nid, "mensaje": "Usuario «%s» creado. Deberá cambiar la contraseña al ingresar." % usuario}


def editar_usuario(ctx):
    uid, d, errores = int(ctx.m.group(1)), ctx.datos, []
    nombre = _obligatorio(d, "nombre", "Nombre completo", errores)
    rol, mercado = _validar_rol_mercado(d, errores)
    activo = 1 if d.get("activo", True) else 0
    if errores:
        raise Error(400, errores)
    with LOCK, BD.sesion() as bd:
        u = bd.uno("SELECT * FROM usuarios WHERE id = ?", (uid,))
        if not u:
            raise Error(404, "El usuario no existe.")
        if u["rol"] == "admin" and u["activo"] and (rol != "admin" or not activo) and not _admins_activos(bd, uid):
            raise Error(400, "No se puede quitar ni desactivar al último administrador activo.")
        if uid == ctx.usr["id"] and not activo:
            raise Error(400, "No puede desactivar su propio usuario.")
        bd.ejecutar("UPDATE usuarios SET nombre = ?, rol = ?, mercado = ?, activo = ? WHERE id = ?",
                    (nombre, rol, mercado, activo, uid))
        if not activo:
            bd.ejecutar("DELETE FROM sesiones WHERE usuario_id = ?", (uid,))
        cambios = []
        for campo, viejo, nuevo in (("nombre", u["nombre"], nombre), ("rol", u["rol"], rol),
                                    ("mercado", u["mercado"], mercado), ("activo", u["activo"], activo)):
            if (viejo or None) != (nuevo or None) and str(viejo) != str(nuevo):
                cambios.append("%s: %s → %s" % (campo, viejo, nuevo))
        bitacora(bd, ctx.usr, "USUARIO_EDITADO", "%s: %s" % (u["usuario"], "; ".join(cambios) or "sin cambios"), ctx.ip)
    return 200, {"ok": True, "mensaje": "Usuario «%s» actualizado." % u["usuario"]}


def restablecer_clave(ctx):
    uid = int(ctx.m.group(1))
    clave = str(ctx.datos.get("clave") or "")
    if len(clave) < 6:
        raise Error(400, "La contraseña temporal debe tener al menos 6 caracteres.")
    with LOCK, BD.sesion() as bd:
        u = bd.uno("SELECT * FROM usuarios WHERE id = ?", (uid,))
        if not u:
            raise Error(404, "El usuario no existe.")
        bd.ejecutar("UPDATE usuarios SET clave = ?, debe_cambiar = 1, intentos_fallidos = 0, bloqueado_hasta = NULL"
                    " WHERE id = ?", (hash_clave(clave), uid))
        bd.ejecutar("DELETE FROM sesiones WHERE usuario_id = ?", (uid,))
        bitacora(bd, ctx.usr, "CLAVE_RESTABLECIDA", "Contraseña de %s restablecida (cambio obligatorio)" % u["usuario"], ctx.ip)
    return 200, {"ok": True, "mensaje": "Contraseña de «%s» restablecida. Deberá cambiarla al ingresar." % u["usuario"]}


def cambiar_clave(ctx):
    actual, nueva = str(ctx.datos.get("actual") or ""), str(ctx.datos.get("nueva") or "")
    errores = []
    if len(nueva) < 8:
        errores.append("La nueva contraseña debe tener al menos 8 caracteres.")
    if nueva == actual:
        errores.append("La nueva contraseña debe ser distinta de la actual.")
    if nueva.lower() in ("admin123", "12345678", "password", "contraseña", CLAVE_DEMO):
        errores.append("Elija una contraseña menos predecible.")
    with LOCK, BD.sesion() as bd:
        u = bd.uno("SELECT * FROM usuarios WHERE id = ?", (ctx.usr["id"],))
        if not verificar_clave(actual, u["clave"]):
            errores.append("La contraseña actual no es correcta.")
        if errores:
            raise Error(400, errores)
        bd.ejecutar("UPDATE usuarios SET clave = ?, debe_cambiar = 0 WHERE id = ?", (hash_clave(nueva), u["id"]))
        bitacora(bd, ctx.usr, "CAMBIO_CLAVE", "El usuario cambió su contraseña", ctx.ip)
    return 200, {"ok": True, "mensaje": "Contraseña actualizada."}


def ver_bitacora(ctx):
    qs = ctx.qs
    cond, par = [], []
    if qs.get("usuario"):
        cond.append("usuario = ?")
        par.append(qs["usuario"])
    if qs.get("accion"):
        cond.append("accion = ?")
        par.append(qs["accion"])
    if qs.get("desde") and RE_FECHA.match(qs["desde"]):
        cond.append("fecha_hora >= ?")
        par.append(qs["desde"])
    if qs.get("hasta") and RE_FECHA.match(qs["hasta"]):
        cond.append("fecha_hora < ?")
        par.append(qs["hasta"] + " 99")
    with BD.sesion() as bd:
        filas = bd.todos("SELECT * FROM bitacora" + _where(cond) + " ORDER BY id DESC LIMIT 500", par)
        acciones = [f["accion"] for f in bd.todos("SELECT DISTINCT accion FROM bitacora ORDER BY accion")]
        usuarios = [f["usuario"] for f in bd.todos("SELECT DISTINCT usuario FROM bitacora WHERE usuario <> '' ORDER BY usuario")]
    return 200, {"registros": filas, "acciones": acciones, "usuarios": usuarios}


def guardar_config(ctx):
    d, errores = ctx.datos, []
    cal = d.get("calidades") or []
    if not isinstance(cal, list) or len(cal) != 3:
        errores.append("Debe indicar los nombres de las 3 calidades.")
        cal = ["", "", ""]
    cal = [str(c or "").strip()[:30] for c in cal]
    if any(not c for c in cal):
        errores.append("Los nombres de las calidades no pueden estar vacíos.")
    elif len(set(c.lower() for c in cal)) < 3:
        errores.append("Los nombres de las calidades deben ser distintos.")
    lpt = _numero(d, "libras_por_taque", "Libras por taque", errores, 500)
    vig = _numero(d, "vigencia_horas", "Horas de vigencia", errores, 720)
    if errores:
        raise Error(400, errores)
    nuevos = {"calidad_1": cal[0], "calidad_2": cal[1], "calidad_3": cal[2],
              "libras_por_taque": _n(lpt).replace(".", "").replace(",", "."), "vigencia_horas": str(int(vig))}
    with LOCK, BD.sesion() as bd:
        antes = {f["clave"]: f["valor"] for f in bd.todos("SELECT clave, valor FROM config")}
        for k, v in nuevos.items():
            bd.ejecutar("UPDATE config SET valor = ? WHERE clave = ?", (v, k))
        cambios = ["%s: %s → %s" % (k, antes.get(k), v) for k, v in nuevos.items() if antes.get(k) != v]
        bitacora(bd, ctx.usr, "CONFIGURACION", "; ".join(cambios) or "sin cambios", ctx.ip)
    return 200, {"ok": True, "mensaje": "Configuración guardada."}


def config_publica(ctx):
    with BD.sesion() as bd:
        cfg = leer_config(bd)
    return 200, {"mercados": MERCADOS, "departamentos": DEPARTAMENTOS, "roles": ROLES,
                 "calidades": cfg["calidades"], "libras_por_taque": cfg["libras_por_taque"],
                 "vigencia_horas": cfg["vigencia_horas"], "tolerancia_peso": TOLERANCIA_PESO,
                 "tolerancia_precio": TOLERANCIA_PRECIO, "hoy": hoy().isoformat(), "ahora": ts(ahora()),
                 "inactividad_min": int(INACTIVIDAD.total_seconds() // 60)}


# ===========================================================================
# Datos de ejemplo (ficticios)
# ===========================================================================
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
PUESTOS = ["Tranca Achica Arriba", "Tranca Senkata", "Tranca Caracollo", "Tranca Parotani",
           "Tranca Colomi", "Tranca Bulo Bulo", "Tranca Yapacaní"]
USUARIOS_DEMO = [("operador_vf", "Rosa Quispe Mamani", "operador", "Villa Fátima (La Paz)"),
                 ("operador_sc", "Freddy Rojas Colque", "operador", "Sacaba (Cochabamba)"),
                 ("supervisor1", "Silvia Vargas Torrez", "supervisor", None),
                 ("control1", "Sgto. Hugo Calle Nina", "controlador", None)]


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


def _placa(rnd):
    return "%d%s" % (rnd.choice([rnd.randint(100, 999), rnd.randint(1000, 5999), rnd.randint(1000, 5999)]),
                     "".join(rnd.choice("BCDFGHJKLMNPRSTVWXYZ") for _ in range(3)))


def generar_datos_ejemplo(bd):
    rnd = random.Random(2026)
    n_ahora = ahora()
    hoy_d = n_ahora.date()
    lpt = 50
    deptos, pesos_depto = list(PESO_DEPTO.keys()), list(PESO_DEPTO.values())

    # Usuarios de prueba (solo para la demostración)
    ids = {}
    for usuario, nombre, rol, mercado in USUARIOS_DEMO:
        ids[usuario] = bd.insertar(
            "INSERT INTO usuarios (usuario, nombre, clave, rol, mercado, activo, debe_cambiar, intentos_fallidos, creado)"
            " VALUES (?,?,?,?,?,1,0,0,?)", (usuario, nombre, hash_clave(CLAVE_DEMO), rol, mercado, ts(n_ahora)))
    op = {"Villa Fátima (La Paz)": (ids["operador_vf"], "Rosa Quispe Mamani (operador_vf)"),
          "Sacaba (Cochabamba)": (ids["operador_sc"], "Freddy Rojas Colque (operador_sc)")}

    productores = []
    for _ in range(140):
        mercado = "Villa Fátima (La Paz)" if rnd.random() < 0.88 else "Sacaba (Cochabamba)"
        proc = rnd.choices(MERCADOS[mercado], PESO_PROCEDENCIA[mercado])[0]
        nombre, ci = _persona(rnd)
        tel = "7%07d" % rnd.randint(0, 9999999) if rnd.random() < 0.6 else ""
        productores.append((mercado, proc, nombre, ci, tel))
    prod_vf = [p for p in productores if p[0].startswith("Villa")]
    prod_sa = [p for p in productores if p[0].startswith("Sacaba")]
    compradores = [_persona(rnd) for _ in range(45)]
    transportistas = [_persona(rnd) for _ in range(30)]
    obs = ["", "", "", "", "", "Hoja seca de buena calidad", "Llegó con lluvia, hoja húmeda",
           "Taques con amarre irregular", "Primera vez en el mercado", "Control rutinario sin novedad"]

    # Precio base por calidad que cambia cada día (paseo aleatorio)
    base = {1: 46.0, 2: 39.0, 3: 31.0}
    limites = {1: (40, 54), 2: (33, 45), 3: (25, 36)}
    precio_dia = {}
    for dd in range(59, -1, -1):
        for c in (1, 2, 3):
            base[c] = min(limites[c][1], max(limites[c][0], base[c] + rnd.uniform(-1.2, 1.2)))
        precio_dia[hoy_d - timedelta(days=dd)] = dict(base)

    entradas, info_e = [], []
    for dd in range(59, -1, -1):
        f = hoy_d - timedelta(days=dd)
        for _ in range(rnd.randint(4, 8)):
            p = rnd.choice(prod_vf if rnd.random() < 0.88 else prod_sa)
            calidad = rnd.choices([1, 2, 3], [30, 50, 20])[0]
            taques = rnd.choices([1, 2, 3, 4, 5, 6, 8, 10, 12], [5, 12, 16, 18, 16, 13, 10, 6, 4])[0]
            libras = round(taques * lpt * rnd.uniform(0.95, 1.07) * 2) / 2
            hora = "%02d:%02d" % (rnd.randint(5, 11), rnd.randint(0, 59))
            if dd == 0 and hora > n_ahora.strftime("%H:%M"):
                hora = n_ahora.strftime("%H:%M")
            eid = len(entradas) + 1
            uid, firma_op = op[p[0]]
            entradas.append((eid, f.isoformat(), hora, p[0], p[2], p[3], p[4], p[1], calidad, taques, libras,
                             rnd.choice(obs), uid, firma_op))
            info_e.append((eid, f, libras, dd, calidad, p[0], hora))

    ventas = []
    for eid, f, libras, dd, calidad, mercado, hora_e in info_e:
        if dd >= 4:
            vender = libras
        elif dd >= 1:
            vender = libras if rnd.random() < 0.4 else libras * rnd.uniform(0.3, 0.9)
        else:
            vender = libras * rnd.uniform(0.2, 0.6) if rnd.random() < 0.5 else 0
        vender = round(vender * 2) / 2 if vender < libras else libras
        if vender <= 0:
            continue
        for trozo in _partir(vender, rnd.choice([1, 1, 2, 2, 3]), rnd):
            fv = min(f + timedelta(days=rnd.choice([0, 0, 0, 1])), hoy_d)
            hv = "%02d:%02d" % (rnd.randint(8, 15), rnd.randint(0, 59)) if fv != f else hora_e[:2] + ":%02d" % rnd.randint(0, 59)
            if fv == hoy_d and hv > n_ahora.strftime("%H:%M"):
                hv = n_ahora.strftime("%H:%M")
            comp = rnd.choice(compradores)
            precio = round(precio_dia[fv][calidad] * rnd.uniform(0.95, 1.05) * 2) / 2
            ventas.append([fv, hv, eid, comp[0], comp[1], trozo, precio, calidad, mercado])
    ventas.sort(key=lambda v: (v[0], v[1], v[2]))
    filas_v = []
    for i, (fv, hv, eid, comp, ci, lb, precio, calidad, mercado) in enumerate(ventas):
        uid, firma_op = op[mercado]
        filas_v.append((i + 1, fv.isoformat(), hv, eid, comp, ci, lb, precio, round(lb * precio, 2), calidad, uid, firma_op))

    salidas = []
    for vid, fv_iso, hv, _, _, _, lb, _, _, _, _, _ in filas_v:
        fv = datetime.strptime(fv_iso, "%Y-%m-%d").date()
        mercado = ventas[vid - 1][8]
        dv = (hoy_d - fv).days
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
        trans = rnd.choice(transportistas)
        placa = _placa(rnd) if rnd.random() < 0.85 else ""
        for trozo in _partir(despachar, 2 if rnd.random() < 0.2 else 1, rnd):
            fs = min(fv + timedelta(days=rnd.choice([0, 0, 1])), hoy_d)
            emit = datetime.combine(fs, datetime.min.time()) + timedelta(hours=rnd.randint(9, 17), minutes=rnd.randint(0, 59))
            if emit > n_ahora:
                emit = n_ahora - timedelta(minutes=rnd.randint(5, 120))
            salidas.append((emit, vid, depto, trozo, trans, placa, mercado))
    salidas.sort(key=lambda s: (s[0], s[1]))
    contador, filas_s = {}, []
    for i, (emit, vid, depto, lb, trans, placa, mercado) in enumerate(salidas):
        contador[emit.year] = contador.get(emit.year, 0) + 1
        uid, firma_op = op[mercado]
        filas_s.append([i + 1, emit.date().isoformat(), emit.strftime("%H:%M"), vid, depto, lb,
                        "HR-%d-%06d" % (emit.year, contador[emit.year]), trans[0], trans[1], placa, ts(emit),
                        ts(emit + timedelta(hours=72)), 0, None, None, None, uid, firma_op])
    # Una hoja anulada (de hace unos 10 días)
    candidatas = [f for f in filas_s if (hoy_d - datetime.strptime(f[1], "%Y-%m-%d").date()).days in range(8, 13)]
    if candidatas:
        a = candidatas[len(candidatas) // 2]
        a[12], a[13] = 1, "Error en la placa del vehículo; se emitió una nueva hoja de ruta."
        a[14], a[15] = "Gerente General (admin)", ts(datetime.strptime(a[10], "%Y-%m-%d %H:%M:%S") + timedelta(hours=2))

    # Verificaciones en trancas
    verifs = []
    for f in filas_s:
        emit = datetime.strptime(f[10], "%Y-%m-%d %H:%M:%S")
        if rnd.random() < 0.55:
            momento = emit + timedelta(hours=rnd.uniform(1, 30))
            if momento < n_ahora:
                resultado = "ANULADA" if f[12] and momento > datetime.strptime(f[15], "%Y-%m-%d %H:%M:%S") else "VALIDA"
                verifs.append((f[6], ts(momento), ids["control1"], "control1", resultado, rnd.choice(PUESTOS)))
    for _ in range(3):
        momento = n_ahora - timedelta(days=rnd.randint(1, 40), hours=rnd.randint(0, 12))
        verifs.append(("HR-%d-%06d" % (momento.year, rnd.randint(900000, 999999)), ts(momento), ids["control1"],
                       "control1", "NO_EXISTE", rnd.choice(PUESTOS)))
    verifs.sort(key=lambda v: v[1])

    bd.lote("entradas", ["id", "fecha", "hora", "mercado", "productor", "ci", "telefono", "procedencia", "calidad",
                         "taques", "libras", "observacion", "usuario_id", "registrado_por"], entradas)
    bd.lote("ventas", ["id", "fecha", "hora", "entrada_id", "comprador", "ci_comprador", "libras", "precio_libra",
                       "total", "calidad", "usuario_id", "registrado_por"], filas_v)
    bd.lote("salidas", ["id", "fecha", "hora", "venta_id", "departamento", "libras", "hoja_ruta", "transportista",
                        "ci_transportista", "placa", "emitida", "vence", "anulada", "motivo_anulacion", "anulada_por",
                        "anulada_en", "usuario_id", "registrado_por"], [tuple(f) for f in filas_s])
    bd.lote("verificaciones", ["codigo", "fecha_hora", "usuario_id", "usuario", "resultado", "puesto"], verifs)
    if ES_PG:
        for t in ("entradas", "ventas", "salidas"):
            bd.ejecutar("SELECT setval(pg_get_serial_sequence('%s', 'id'), (SELECT MAX(id) FROM %s))" % (t, t))
    bitacora(bd, None, "SISTEMA", "Datos de ejemplo generados: %d entradas, %d ventas, %d salidas, %d verificaciones"
             % (len(entradas), len(filas_v), len(filas_s), len(verifs)))
    print("  %d entradas, %d ventas, %d salidas, %d verificaciones generadas." % (
        len(entradas), len(filas_v), len(filas_s), len(verifs)))
    print("  Usuarios de prueba (contraseña %s): %s" % (CLAVE_DEMO, ", ".join(u[0] for u in USUARIOS_DEMO)))


# ===========================================================================
# Rutas de la API:  (método, patrón, permiso, función)
#   permiso: None = público · "sesion" = cualquier usuario con sesión · clave de PERMISOS
# ===========================================================================
RUTAS = [
    ("GET", r"/api/config", None, config_publica),
    ("GET", r"/api/publico/precios", None, precios_publicos),
    ("POST", r"/api/publico/hoja", None, consultar_hoja_publica),
    ("GET", r"/api/resumen", "panel", resumen),
    ("GET", r"/api/precio-referencia", "registrar", ref_precio),
    ("GET", r"/api/entradas", "registrar", listar_entradas),
    ("POST", r"/api/entradas", "registrar", crear_entrada),
    ("GET", r"/api/ventas", "registrar", listar_ventas),
    ("POST", r"/api/ventas", "registrar", crear_venta),
    ("GET", r"/api/salidas", "registrar", listar_salidas),
    ("POST", r"/api/salidas", "registrar", crear_salida),
    ("GET", r"/api/hoja-ruta/([A-Za-z0-9%\-]+)", "hoja", ver_hoja),
    ("GET", r"/api/hojas", "hojas", listar_salidas),
    ("POST", r"/api/hojas/([A-Za-z0-9%\-]+)/anular", "admin", anular_hoja),
    ("POST", r"/api/verificar", "verificar", verificar),
    ("GET", r"/api/exportar/departamentos\.csv", "reportes", csv_departamentos),
    ("GET", r"/api/exportar/calidad\.csv", "reportes", csv_calidad),
    ("GET", r"/api/exportar/salidas\.csv", "reportes", csv_salidas),
    ("GET", r"/api/usuarios", "admin", listar_usuarios),
    ("POST", r"/api/usuarios", "admin", crear_usuario),
    ("POST", r"/api/usuarios/(\d+)", "admin", editar_usuario),
    ("POST", r"/api/usuarios/(\d+)/clave", "admin", restablecer_clave),
    ("GET", r"/api/bitacora", "admin", ver_bitacora),
    ("POST", r"/api/config", "admin", guardar_config),
    ("POST", r"/api/clave", "sesion", cambiar_clave),
]
RUTAS = [(m, re.compile("^" + p + "$"), perm, f) for m, p, perm, f in RUTAS]


class Ctx:
    def __init__(self, handler, usr, qs, datos, m):
        self.usr, self.qs, self.datos, self.m = usr, qs, datos, m
        self.ip = handler._ip()


# ===========================================================================
# Servidor HTTP
# ===========================================================================
TIPOS = {".html": "text/html; charset=utf-8", ".js": "application/javascript; charset=utf-8",
         ".css": "text/css; charset=utf-8", ".png": "image/png", ".svg": "image/svg+xml",
         ".ico": "image/x-icon", ".txt": "text/plain; charset=utf-8", ".json": "application/json"}
COOKIE = "sesion_coca"


class Manejador(BaseHTTPRequestHandler):
    server_version = "ControlCoca/3.0"
    sys_version = ""
    silencioso = False

    def log_message(self, fmt, *args):
        if not self.silencioso and "/api/" in (self.path or ""):
            sys.stderr.write("%s  %s\n" % (self.log_date_time_string(), fmt % args))

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

    def _token(self):
        c = SimpleCookie()
        try:
            c.load(self.headers.get("Cookie") or "")
        except Exception:
            return None
        return c[COOKIE].value if COOKIE in c else None

    def _cookie(self, token, segundos):
        seguro = "; Secure" if self.headers.get("X-Forwarded-Proto") == "https" else ""
        return "%s=%s; Path=/; HttpOnly; SameSite=Strict; Max-Age=%d%s" % (COOKIE, token, segundos, seguro)

    def _ip(self):
        return (self.headers.get("X-Forwarded-For") or self.client_address[0]).split(",")[0].strip()

    def do_HEAD(self):
        self.do_GET()

    def do_GET(self):
        url = urlparse(self.path)
        if url.path.startswith("/api/"):
            return self._api("GET", url, {})
        try:
            return self._estatico(url.path)
        except Exception as e:
            sys.stderr.write("ERROR %s: %r\n" % (self.path, e))
            self._enviar(500, "Error interno", "text/plain; charset=utf-8")

    def do_POST(self):
        url = urlparse(self.path)
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
        return self._api("POST", url, datos)

    def _api(self, metodo, url, datos):
        ruta = url.path
        qs = {k: v[0] for k, v in parse_qs(url.query).items()}
        try:
            # --- rutas de sesión
            if ruta == "/api/login" and metodo == "POST":
                codigo, resp, token = login(datos, self._ip())
                extra = {"Set-Cookie": self._cookie(token, 12 * 3600)} if token else None
                return self._json(codigo, resp, extra)
            token = self._token()
            usr, motivo = usuario_de_token(token)
            if ruta == "/api/logout" and metodo == "POST":
                logout(token, usr, self._ip())
                return self._json(200, {"ok": True}, {"Set-Cookie": self._cookie("", 0)})
            if ruta == "/api/sesion" and metodo == "GET":
                return self._json(200, {"usuario": publico(usr) if usr else None, "motivo": motivo})

            for m_, patron, permiso, funcion in RUTAS:
                m = patron.match(ruta)
                if not m or m_ != metodo:
                    continue
                if permiso is not None:
                    if not usr:
                        msg = ("Su sesión se cerró por %d minutos sin uso. Ingrese de nuevo." % (INACTIVIDAD.seconds // 60)
                               if motivo == "inactividad" else "Debe iniciar sesión.")
                        return self._json(401, {"errores": [msg], "motivo": motivo})
                    if usr["debe_cambiar"] and funcion is not cambiar_clave:
                        return self._json(403, {"errores": ["Debe cambiar su contraseña antes de continuar."],
                                                "debe_cambiar": True})
                    if permiso != "sesion" and usr["rol"] not in PERMISOS[permiso]:
                        return self._json(403, {"errores": ["Su rol (%s) no tiene permiso para esta acción."
                                                            % ROLES.get(usr["rol"], usr["rol"])]})
                resultado = funcion(Ctx(self, usr, qs, datos, m))
                if resultado[0] == "csv":
                    return self._enviar(200, "﻿" + resultado[2], "text/csv; charset=utf-8",
                                        {"Content-Disposition": 'attachment; filename="%s"' % resultado[1]})
                return self._json(*resultado)
            return self._json(404, {"errores": ["Ruta no encontrada."]})
        except Error as e:
            return self._json(e.codigo, {"errores": e.errores})
        except Exception as e:
            sys.stderr.write("ERROR %s %s: %r\n" % (metodo, self.path, e))
            return self._json(500, {"errores": ["Error interno del servidor. Intente de nuevo."]})

    def _estatico(self, ruta):
        if ruta in ("/", ""):
            ruta = "/index.html"
        destino = os.path.normpath(os.path.join(STATIC_DIR, unquote(ruta).lstrip("/")))
        if not destino.startswith(STATIC_DIR + os.sep) or not os.path.isfile(destino):
            return self._enviar(404, "No encontrado", "text/plain; charset=utf-8")
        with open(destino, "rb") as f:
            datos = f.read()
        self._enviar(200, datos, TIPOS.get(os.path.splitext(destino)[1].lower(), "application/octet-stream"))


def crear_servidor(host=HOST, puerto=PORT):
    servidor = ThreadingHTTPServer((host, puerto), Manejador)
    servidor.daemon_threads = True
    return servidor


def main():
    puerto = int(sys.argv[1]) if len(sys.argv) > 1 else PORT
    iniciar_bd()
    servidor = crear_servidor(HOST, puerto)
    print("=" * 60)
    print(" Sistema de Control de Comercialización de la Hoja de Coca")
    print(" Abra en su navegador:  http://localhost:%d" % puerto if not EN_LA_NUBE else " Escuchando en el puerto %d" % puerto)
    print(" Presione Ctrl+C para detener el servidor.")
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
