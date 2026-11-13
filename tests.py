# -*- coding: utf-8 -*-
"""
Pruebas automáticas del Sistema de Control de la Hoja de Coca.
Ejecutar:   python tests.py        (usa una base de datos temporal; no toca control.db)
"""
import http.cookiejar
import json
import os
import sqlite3
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from datetime import timedelta

_TMP = tempfile.mkdtemp(prefix="coca_tests_")
os.environ["CONTROL_DB"] = os.path.join(_TMP, "prueba.db")
os.environ.pop("DATABASE_URL", None)
os.environ.pop("ADMIN_CLAVE", None)
os.environ.pop("PORT", None)
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import app  # noqa: E402

VF = "Villa Fátima (La Paz)"
SC = "Sacaba (Cochabamba)"
CLAVE_ADMIN_NUEVA = "Gerente-2026!"


class Cliente:
    """Navegador mínimo con su propia cookie de sesión."""

    def __init__(self, base):
        self.base = base
        self.op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))

    def pedir(self, metodo, ruta, datos=None):
        cuerpo = json.dumps(datos).encode() if datos is not None else None
        cab = {"Content-Type": "application/json"} if datos is not None else {}
        req = urllib.request.Request(self.base + ruta, cuerpo, cab, method=metodo)
        try:
            with self.op.open(req, timeout=30) as r:
                crudo, cod = r.read(), r.status
        except urllib.error.HTTPError as e:
            crudo, cod = e.read(), e.code
        try:
            return cod, json.loads(crudo.decode("utf-8"))
        except ValueError:
            return cod, crudo

    def get(self, ruta):
        return self.pedir("GET", ruta)

    def post(self, ruta, datos=None):
        return self.pedir("POST", ruta, datos if datos is not None else {})

    def entrar(self, usuario, clave):
        return self.post("/api/login", {"usuario": usuario, "clave": clave})


def sql(consulta, params=()):
    with app.BD.sesion() as bd:
        if consulta.lstrip().upper().startswith("SELECT"):
            return bd.todos(consulta, params)
        bd.ejecutar(consulta, params)


class PruebasSistema(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        app.Manejador.silencioso = True
        app.iniciar_bd()
        cls.srv = app.crear_servidor("127.0.0.1", 0)
        cls.base = "http://127.0.0.1:%d" % cls.srv.server_address[1]
        threading.Thread(target=cls.srv.serve_forever, daemon=True).start()
        # El administrador cambia la contraseña inicial una vez para el resto de pruebas
        a = Cliente(cls.base)
        a.entrar("admin", "admin123")
        cod, _ = a.post("/api/clave", {"actual": "admin123", "nueva": CLAVE_ADMIN_NUEVA})
        assert cod == 200

    @classmethod
    def tearDownClass(cls):
        cls.srv.shutdown()
        cls.srv.server_close()
        app.BD.cerrar_todo()

    def cliente(self, usuario=None, clave="prueba123"):
        c = Cliente(self.base)
        if usuario:
            cod, r = c.entrar(usuario, CLAVE_ADMIN_NUEVA if usuario == "admin" else clave)
            self.assertEqual(cod, 200, r)
        return c

    def _entrada(self, c, **extra):
        datos = {"mercado": VF, "procedencia": "Sud Yungas", "productor": "Prueba Test", "ci": "4567890",
                 "taques": 3, "libras": 150, "calidad": 1}
        datos.update(extra)
        cod, r = c.post("/api/entradas", datos)
        self.assertEqual(cod, 201, r)
        return r["id"]

    def _venta(self, c, entrada_id, libras=100, precio=None):
        if precio is None:
            cod, ref = c.get("/api/precio-referencia?calidad=1")
            precio = ref["precio"] or 45
        cod, r = c.post("/api/ventas", {"entrada_id": entrada_id, "comprador": "Comercial Test",
                                        "ci_comprador": "7654321", "libras": libras, "precio_libra": precio})
        self.assertEqual(cod, 201, r)
        return r

    def _salida(self, c, venta_id, libras=100, **extra):
        datos = {"venta_id": venta_id, "departamento": "Tarija", "libras": libras,
                 "transportista": "Juan Chofer Pérez", "ci_transportista": "3344556", "placa": "2345ABC"}
        datos.update(extra)
        cod, r = c.post("/api/salidas", datos)
        self.assertEqual(cod, 201, r)
        return r["hoja_ruta"]

    # ------------------------------------------------------------------ inicio de sesión
    def test_01_login_correcto_e_incorrecto(self):
        c = Cliente(self.base)
        cod, r = c.entrar("operador_vf", "prueba123")
        self.assertEqual(cod, 200)
        self.assertEqual(r["usuario"]["rol"], "operador")
        self.assertEqual(r["usuario"]["mercado"], VF)
        cod, r = Cliente(self.base).entrar("operador_vf", "mala")
        self.assertEqual(cod, 401)
        self.assertEqual(r["errores"], ["Usuario o contraseña incorrectos."])
        cod, r = Cliente(self.base).entrar("no_existe", "x")
        self.assertEqual(cod, 401)
        self.assertEqual(r["errores"], ["Usuario o contraseña incorrectos."])

    def test_02_sin_sesion_no_hay_acceso(self):
        c = Cliente(self.base)
        for ruta in ("/api/resumen", "/api/entradas", "/api/bitacora", "/api/hoja-ruta/HR-2026-000001"):
            self.assertEqual(c.get(ruta)[0], 401, ruta)
        self.assertEqual(c.post("/api/verificar", {"codigo": "HR-2026-000001"})[0], 401)
        self.assertEqual(c.get("/api/config")[0], 200)

    def test_03_admin_obligado_a_cambiar_clave(self):
        # Un usuario recién creado (o con clave restablecida) debe cambiarla antes de hacer cualquier cosa
        a = self.cliente("admin")
        cod, r = a.post("/api/usuarios", {"usuario": "nuevo_op", "nombre": "Nuevo Operador", "clave": "temporal1",
                                          "rol": "operador", "mercado": SC})
        self.assertEqual(cod, 201, r)
        n = Cliente(self.base)
        cod, r = n.entrar("nuevo_op", "temporal1")
        self.assertTrue(r["usuario"]["debe_cambiar"])
        cod, r = n.get("/api/entradas")
        self.assertEqual(cod, 403)
        self.assertTrue(r.get("debe_cambiar"))
        self.assertEqual(n.post("/api/clave", {"actual": "temporal1", "nueva": "otraClave99"})[0], 200)
        self.assertEqual(n.get("/api/entradas")[0], 200)

    def test_04_bloqueo_tras_5_intentos(self):
        a = self.cliente("admin")
        a.post("/api/usuarios", {"usuario": "bloq_test", "nombre": "Para Bloquear", "clave": "temporal1", "rol": "supervisor"})
        c = Cliente(self.base)
        for _ in range(5):
            self.assertEqual(c.entrar("bloq_test", "incorrecta")[0], 401)
        cod, r = c.entrar("bloq_test", "temporal1")  # contraseña correcta, pero está bloqueado
        self.assertEqual(cod, 429)
        self.assertIn("bloqueado", r["errores"][0])
        cod, b = a.get("/api/bitacora?accion=USUARIO_BLOQUEADO")
        self.assertTrue(any("bloq_test" == x["usuario"] for x in b["registros"]))
        # Pasados los 5 minutos puede entrar
        sql("UPDATE usuarios SET bloqueado_hasta = ? WHERE usuario = 'bloq_test'",
            (app.ts(app.ahora() - timedelta(minutes=1)),))
        self.assertEqual(c.entrar("bloq_test", "temporal1")[0], 200)

    def test_05_sesion_vence_por_inactividad(self):
        c = self.cliente("supervisor1")
        self.assertEqual(c.get("/api/resumen")[0], 200)
        sql("UPDATE sesiones SET ultimo_uso = ? WHERE usuario_id = (SELECT id FROM usuarios WHERE usuario = 'supervisor1')",
            (app.ts(app.ahora() - timedelta(minutes=31)),))
        cod, r = c.get("/api/resumen")
        self.assertEqual(cod, 401)
        self.assertEqual(r.get("motivo"), "inactividad")

    # ------------------------------------------------------------------ permisos
    def test_06_permisos_por_rol(self):
        op, sup, ctl = self.cliente("operador_vf"), self.cliente("supervisor1"), self.cliente("control1")
        casos = [
            (ctl, "GET", "/api/resumen", None, 403),
            (ctl, "GET", "/api/entradas", None, 403),
            (ctl, "POST", "/api/verificar", {"codigo": "HR-2026-000001"}, 200),
            (sup, "POST", "/api/entradas", {"mercado": VF}, 403),
            (sup, "POST", "/api/verificar", {"codigo": "HR-2026-000001"}, 403),
            (sup, "GET", "/api/exportar/calidad.csv", None, 200),
            (sup, "GET", "/api/bitacora", None, 403),
            (op, "GET", "/api/bitacora", None, 403),
            (op, "GET", "/api/usuarios", None, 403),
            (op, "GET", "/api/exportar/salidas.csv", None, 403),
            (op, "POST", "/api/hojas/HR-2026-000001/anular", {"motivo": "prueba de permiso"}, 403),
            (op, "POST", "/api/config", {}, 403),
            (sup, "POST", "/api/usuarios", {}, 403),
        ]
        for c, metodo, ruta, datos, esperado in casos:
            cod, _ = c.pedir(metodo, ruta, datos)
            self.assertEqual(cod, esperado, "%s %s" % (metodo, ruta))

    def test_07_operador_limitado_a_su_mercado(self):
        vf, sc = self.cliente("operador_vf"), self.cliente("operador_sc")
        # Aunque envíe otro mercado, la entrada queda en el suyo
        eid = self._entrada(vf, mercado=SC, procedencia="Nor Yungas")
        self.assertEqual(sql("SELECT mercado FROM entradas WHERE id = ?", (eid,))[0]["mercado"], VF)
        cod, filas = vf.get("/api/entradas")
        self.assertTrue(filas and all(f["mercado"] == VF for f in filas))
        cod, r = vf.get("/api/resumen?mercado=" + urllib.request.quote(SC))
        self.assertEqual(r["mercado"], VF)
        # No puede vender una entrada de otro mercado
        cod, r = sc.post("/api/ventas", {"entrada_id": eid, "comprador": "X Y", "ci_comprador": "1234567",
                                         "libras": 10, "precio_libra": 40})
        self.assertEqual(cod, 403)
        hoja = self._salida(vf, self._venta(vf, eid, 50)["id"], 50)
        self.assertEqual(sc.get("/api/hoja-ruta/" + hoja)[0], 403)
        self.assertEqual(vf.get("/api/hoja-ruta/" + hoja)[0], 200)

    # ------------------------------------------------------------------ reglas de negocio
    def test_08_no_vender_mas_del_saldo(self):
        c = self.cliente("operador_vf")
        eid = self._entrada(c)
        cod, r = c.post("/api/ventas", {"entrada_id": eid, "comprador": "Comercial Test", "ci_comprador": "7654321",
                                        "libras": 151, "precio_libra": 40})
        self.assertEqual(cod, 400)
        self.assertIn("supera", r["errores"][0])
        self._venta(c, eid, 100)
        cod, r = c.post("/api/ventas", {"entrada_id": eid, "comprador": "Otro", "ci_comprador": "7654321",
                                        "libras": 60, "precio_libra": 40})
        self.assertEqual(cod, 400)
        self.assertIn("50 lb", r["errores"][0])

    def test_09_no_despachar_mas_del_saldo(self):
        c = self.cliente("operador_vf")
        vid = self._venta(c, self._entrada(c), 100)["id"]
        cod, r = c.post("/api/salidas", {"venta_id": vid, "departamento": "Tarija", "libras": 150,
                                         "transportista": "Juan Chofer", "ci_transportista": "3344556"})
        self.assertEqual(cod, 400)
        self._salida(c, vid, 100, placa="")  # placa opcional
        cod, r = c.post("/api/salidas", {"venta_id": vid, "departamento": "Tarija", "libras": 1,
                                         "transportista": "Juan Chofer", "ci_transportista": "3344556"})
        self.assertEqual(cod, 400)

    def test_10_validaciones_de_datos(self):
        c = self.cliente("operador_vf")
        cod, r = c.post("/api/entradas", {"procedencia": "Chapare", "productor": "X", "ci": "12AB", "taques": 3,
                                          "libras": 150, "calidad": 1})
        self.assertEqual(cod, 400)
        texto = " ".join(r["errores"])
        self.assertIn("no corresponde", texto)
        self.assertIn("CI del productor inválido", texto)
        cod, r = c.post("/api/entradas", {"procedencia": "Sud Yungas", "productor": "X", "ci": "1234567",
                                          "taques": 2, "libras": 900, "calidad": 2})
        self.assertEqual(cod, 400)
        self.assertIn("no es razonable", r["errores"][0])
        cod, r = c.post("/api/entradas", {"procedencia": "Sud Yungas", "productor": "X", "ci": "1234567-1A",
                                          "taques": 3, "libras": 190, "calidad": 3})
        self.assertEqual(cod, 201)
        self.assertTrue(r["avisos"])
        vid = self._venta(c, r["id"], 50)["id"]
        cod, r = c.post("/api/salidas", {"venta_id": vid, "departamento": "Lima", "libras": 10, "transportista": "A B",
                                         "ci_transportista": "1234567", "placa": "AB-12"})
        self.assertEqual(cod, 400)
        self.assertEqual(len(r["errores"]), 2)  # departamento y placa

    def test_11_aviso_precio_fuera_de_rango(self):
        c = self.cliente("operador_vf")
        cod, ref = c.get("/api/precio-referencia?calidad=1")
        self.assertTrue(ref["precio"])
        eid = self._entrada(c, calidad=1)
        r = self._venta(c, eid, 20, precio=round(ref["precio"] * 2, 1))
        self.assertTrue(r["avisos"], "Debe avisar si el precio duplica la referencia")
        self.assertIn("por encima", r["avisos"][0])
        r = self._venta(c, eid, 20, precio=ref["precio"])
        self.assertFalse(r["avisos"])
        r = self._venta(c, eid, 20, precio=round(ref["precio"] * 0.5, 1))
        self.assertIn("por debajo", r["avisos"][0])

    # ------------------------------------------------------------------ hoja de ruta
    def test_12_hoja_valida_vencida_anulada(self):
        op, ctl, adm = self.cliente("operador_vf"), self.cliente("control1"), self.cliente("admin")
        hoja = self._salida(op, self._venta(op, self._entrada(op), 80)["id"], 80)
        self.assertRegex(hoja, r"^HR-\d{4}-\d{6}$")
        cod, r = ctl.post("/api/verificar", {"codigo": hoja.lower(), "puesto": "Tranca Senkata"})
        self.assertEqual(r["resultado"], "VALIDA")
        self.assertEqual(r["hoja"]["departamento"], "Tarija")
        self.assertEqual(r["hoja"]["transportista"], "Juan Chofer Pérez")
        # vencida
        sql("UPDATE salidas SET vence = ? WHERE hoja_ruta = ?", (app.ts(app.ahora() - timedelta(hours=1)), hoja))
        self.assertEqual(ctl.post("/api/verificar", {"codigo": hoja})[1]["resultado"], "VENCIDA")
        sql("UPDATE salidas SET vence = ? WHERE hoja_ruta = ?", (app.ts(app.ahora() + timedelta(hours=10)), hoja))
        # anulada: solo admin y con motivo
        self.assertEqual(adm.post("/api/hojas/%s/anular" % hoja, {"motivo": ""})[0], 400)
        self.assertEqual(adm.post("/api/hojas/%s/anular" % hoja, {"motivo": "Carga duplicada"})[0], 200)
        self.assertEqual(adm.post("/api/hojas/%s/anular" % hoja, {"motivo": "Otra vez"})[0], 400)
        cod, r = ctl.post("/api/verificar", {"codigo": hoja})
        self.assertEqual(r["resultado"], "ANULADA")
        self.assertFalse(r["valida"])
        self.assertEqual(r["hoja"]["motivo_anulacion"], "Carga duplicada")
        self.assertEqual(ctl.post("/api/verificar", {"codigo": "HR-1999-123456"})[1]["resultado"], "NO_EXISTE")
        # cada verificación queda registrada
        filas = sql("SELECT resultado, usuario, puesto FROM verificaciones WHERE codigo = ? ORDER BY id", (hoja,))
        self.assertEqual([f["resultado"] for f in filas], ["VALIDA", "VENCIDA", "ANULADA"])
        self.assertEqual(filas[0]["usuario"], "control1")
        self.assertEqual(filas[0]["puesto"], "Tranca Senkata")
        cod, h = adm.get("/api/hoja-ruta/" + hoja)
        self.assertEqual(h["estado"], "ANULADA")
        self.assertEqual(h["verificaciones"], 3)

    def test_13_codigos_correlativos_y_unicos(self):
        op = self.cliente("operador_vf")
        vid = self._venta(op, self._entrada(op), 30)["id"]
        h1, h2 = self._salida(op, vid, 10), self._salida(op, vid, 10)
        self.assertEqual(int(h2[-6:]), int(h1[-6:]) + 1)

    # ------------------------------------------------------------------ bitácora y administración
    def test_14_registro_en_bitacora(self):
        Cliente(self.base).entrar("operador_vf", "clave-mala")
        op = self.cliente("operador_vf")
        eid = self._entrada(op)
        adm = self.cliente("admin")
        cod, b = adm.get("/api/bitacora")
        acciones = {x["accion"] for x in b["registros"]}
        for a in ("LOGIN", "LOGIN_FALLIDO", "ENTRADA", "VENTA", "SALIDA", "VERIFICACION", "USUARIO_CREADO", "CAMBIO_CLAVE"):
            self.assertIn(a, acciones)
        cod, b = adm.get("/api/bitacora?usuario=operador_vf&accion=ENTRADA")
        self.assertTrue(any("Nº %d" % eid in x["detalle"] for x in b["registros"]))
        op.post("/api/logout")
        cod, b = adm.get("/api/bitacora?accion=LOGOUT")
        self.assertTrue(b["registros"])

    def test_15_no_desactivar_ultimo_admin(self):
        adm = self.cliente("admin")
        uid = sql("SELECT id FROM usuarios WHERE usuario = 'admin'")[0]["id"]
        cod, r = adm.post("/api/usuarios/%d" % uid, {"nombre": "Gerente", "rol": "supervisor"})
        self.assertEqual(cod, 400)
        self.assertIn("último administrador", r["errores"][0])

    def test_16_restablecer_clave_y_configuracion(self):
        adm = self.cliente("admin")
        uid = sql("SELECT id FROM usuarios WHERE usuario = 'operador_sc'")[0]["id"]
        self.assertEqual(adm.post("/api/usuarios/%d/clave" % uid, {"clave": "temporal9"})[0], 200)
        n = Cliente(self.base)
        cod, r = n.entrar("operador_sc", "temporal9")
        self.assertTrue(r["usuario"]["debe_cambiar"])
        n.post("/api/clave", {"actual": "temporal9", "nueva": "prueba123"})  # predecible: no se acepta
        self.assertEqual(n.get("/api/entradas")[0], 403)
        self.assertEqual(n.post("/api/clave", {"actual": "temporal9", "nueva": "NuevaClave77"})[0], 200)
        # configuración: nombres de calidades y vigencia
        cod, r = adm.post("/api/config", {"calidades": ["Extra", "Común", "Descarte"], "libras_por_taque": 50,
                                          "vigencia_horas": 48})
        self.assertEqual(cod, 200, r)
        cfg = Cliente(self.base).get("/api/config")[1]
        self.assertEqual(cfg["calidades"]["1"], "Extra")
        self.assertEqual(cfg["vigencia_horas"], 48)
        adm.post("/api/config", {"calidades": ["Primera", "Segunda", "Tercera"], "libras_por_taque": 50,
                                 "vigencia_horas": 72})
        self.assertEqual(adm.post("/api/config", {"calidades": ["A", "A", "B"], "libras_por_taque": 50,
                                                  "vigencia_horas": 72})[0], 400)

    def test_17_reportes_y_csv(self):
        sup = self.cliente("supervisor1")
        cod, r = sup.get("/api/resumen?calidad=1")
        self.assertEqual(cod, 200)
        self.assertEqual(len(r["por_calidad"]), 3)
        self.assertEqual(len(r["precio_hoy"]), 3)
        self.assertGreater(r["hojas_estado"]["VENCIDA"], 0)
        self.assertGreater(r["hojas_estado"]["ANULADA"], 0)
        self.assertGreater(r["verificaciones"]["total"], 0)
        for nombre in ("departamentos", "salidas", "calidad"):
            req = urllib.request.Request(self.base + "/api/exportar/%s.csv" % nombre)
            with sup.op.open(req) as resp:
                self.assertTrue(resp.read().startswith(b"\xef\xbb\xbf"), nombre)


class PruebaMigracion(unittest.TestCase):
    def test_migra_base_antigua_sin_borrar_datos(self):
        ruta = os.path.join(_TMP, "antigua.db")
        con = sqlite3.connect(ruta)
        con.executescript("""
            CREATE TABLE entradas (id INTEGER PRIMARY KEY AUTOINCREMENT, fecha TEXT NOT NULL, mercado TEXT NOT NULL,
              productor TEXT NOT NULL, ci TEXT NOT NULL, procedencia TEXT NOT NULL, taques REAL NOT NULL,
              libras REAL NOT NULL, observacion TEXT DEFAULT '');
            CREATE TABLE ventas (id INTEGER PRIMARY KEY AUTOINCREMENT, fecha TEXT NOT NULL, entrada_id INTEGER NOT NULL,
              comprador TEXT NOT NULL, ci_comprador TEXT NOT NULL, libras REAL NOT NULL, precio_libra REAL NOT NULL,
              total REAL NOT NULL);
            CREATE TABLE salidas (id INTEGER PRIMARY KEY AUTOINCREMENT, fecha TEXT NOT NULL, venta_id INTEGER NOT NULL,
              departamento TEXT NOT NULL, libras REAL NOT NULL, hoja_ruta TEXT NOT NULL UNIQUE, placa TEXT NOT NULL);
            CREATE TABLE usuarios (id INTEGER PRIMARY KEY AUTOINCREMENT, usuario TEXT NOT NULL UNIQUE, nombre TEXT NOT NULL,
              clave TEXT NOT NULL, rol TEXT NOT NULL DEFAULT 'operador', activo INTEGER NOT NULL DEFAULT 1, creado TEXT NOT NULL);
            CREATE TABLE sesiones (token TEXT PRIMARY KEY, usuario_id INTEGER NOT NULL, expira TEXT NOT NULL);
            INSERT INTO entradas VALUES (1, '2026-10-01', 'Villa Fátima (La Paz)', 'Antiguo Productor', '1234567', 'Nor Yungas', 2, 100, '');
            INSERT INTO ventas VALUES (1, '2026-10-01', 1, 'Antiguo Comprador', '7654321', 100, 40, 4000);
            INSERT INTO salidas VALUES (1, '2026-10-02', 1, 'Tarija', 100, 'HR-2026-000001', '2345-KTR');
            INSERT INTO usuarios VALUES (1, 'admin', 'Administrador', 'x', 'admin', 1, '2026-10-01');
        """)
        con.commit()
        app.migrar(app.Conexion(con, False))
        con.commit()
        self.assertEqual(con.execute("PRAGMA user_version").fetchone()[0], app.VERSION_BD)
        self.assertEqual(con.execute("SELECT productor, calidad FROM entradas").fetchone(), ("Antiguo Productor", 2))
        s = con.execute("SELECT hoja_ruta, emitida, vence, anulada FROM salidas").fetchone()
        self.assertEqual(s, ("HR-2026-000001", "2026-10-02 12:00:00", "2026-10-05 12:00:00", 0))
        self.assertEqual(con.execute("SELECT COUNT(*) FROM ventas").fetchone()[0], 1)
        cols = {f[1] for f in con.execute("PRAGMA table_info(usuarios)")}
        self.assertTrue({"mercado", "debe_cambiar", "intentos_fallidos", "bloqueado_hasta"} <= cols)
        con.close()


if __name__ == "__main__":
    unittest.main(verbosity=2)
