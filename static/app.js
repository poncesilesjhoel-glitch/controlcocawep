/* =====================================================================
   Sistema de Control de Comercialización de la Hoja de Coca
   Interfaz en JavaScript puro (rutas por hash #/)
   ===================================================================== */
'use strict';

let CONFIG = null;
let SESION = null;          // usuario con sesión iniciada o null
let ULTIMO_ID = {};         // para resaltar la fila recién registrada
const $app = document.getElementById('app');
const MOVIMIENTO = !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const PRIVADAS = ['entradas', 'ventas', 'salidas', 'usuarios', 'cuenta'];

/* ------------------------------------------------------------------ íconos */
const ICO = {
  entrada: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12M7 10l5 5 5-5"/><path d="M4 17v3h16v-3"/></svg>',
  venta: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M15 9.5c-.5-1-1.6-1.5-3-1.5-1.7 0-3 .8-3 2s1.3 1.7 3 2 3 .8 3 2-1.3 2-3 2c-1.4 0-2.6-.6-3-1.6M12 6v2M12 16v2"/></svg>',
  camion: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h11v10H3zM14 9h4l3 3v4h-7"/><circle cx="7" cy="17.5" r="1.8"/><circle cx="17" cy="17.5" r="1.8"/></svg>',
  precio: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 12l-8 8-9-9V3h8z"/><circle cx="7.5" cy="7.5" r="1.5"/></svg>',
  almacen: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 9l9-5 9 5v11H3z"/><path d="M8 20v-6h8v6"/></svg>',
  buscar: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/></svg>',
  usuario: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="8" r="4"/><path d="M4 21c1-4 4-6 8-6s7 2 8 6"/></svg>',
  candado: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>',
  hoja: '<svg viewBox="0 0 32 32"><path d="M16 2C8 9 6 18 16 30C26 18 24 9 16 2Z" fill="#fff"/><path d="M16 6V28" stroke="#15301F" stroke-width="1.2"/></svg>',
  qr: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><path d="M14 14h3v3M21 14v7h-7"/></svg>',
};
const hojasDeco = () => '<div class="hojas-deco" aria-hidden="true">' + ICO.hoja.repeat(4) + '</div>';

/* ------------------------------------------------------------------ formato */
// Formato boliviano: miles con "." y decimales con ",": 1.250 / 4.000,00
function fmtNum(n, dec) {
  n = Number(n) || 0;
  const neg = n < 0;
  const s = Math.abs(n).toFixed(dec === undefined ? 2 : dec);
  let [ent, frac] = s.split('.');
  ent = ent.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return (neg ? '-' : '') + ent + (frac ? ',' + frac : '');
}
const tieneDec = n => Math.abs((Number(n) || 0) % 1) > 0.001;
const fmtLb = n => fmtNum(n, tieneDec(n) ? 1 : 0) + ' lb';
const fmtBs = n => 'Bs ' + fmtNum(n, 2);
const fmtPct = n => fmtNum(n, 1) + ' %';
const fmtTq = n => fmtNum(n, tieneDec(n) ? 1 : 0);
const FORMATOS = { lb: fmtLb, bs: fmtBs, n: v => fmtNum(v, 0), tq: fmtTq, pct: fmtPct };
const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
const DIAS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
const fmtFecha = iso => { if (!iso) return ''; const [a, m, d] = iso.split('-'); return d + '/' + m + '/' + a; };
const fmtFechaCorta = iso => { const [, m, d] = iso.split('-'); return d + '/' + m; };
const fmtFechaLarga = iso => { const [a, m, d] = iso.split('-'); return Number(d) + ' de ' + MESES[Number(m) - 1] + ' de ' + a; };
const fmtMes = ym => { const [a, m] = ym.split('-'); return MESES[Number(m) - 1].replace(/^./, c => c.toUpperCase()) + ' ' + a; };
function esc(s) {
  return String(s === null || s === undefined ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function isoLocal(d) {
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
const hoyISO = () => isoLocal(new Date());
function qsString(obj) {
  const p = new URLSearchParams();
  Object.keys(obj).forEach(k => { if (obj[k] !== '' && obj[k] !== undefined && obj[k] !== null) p.set(k, obj[k]); });
  const s = p.toString();
  return s ? '?' + s : '';
}
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
function opciones(lista, sel, vacio) {
  return (vacio ? '<option value="">' + esc(vacio) + '</option>' : '') +
    lista.map(v => '<option' + (v === sel ? ' selected' : '') + '>' + esc(v) + '</option>').join('');
}
const iniciales = n => (n || '?').split(/\s+/).filter(Boolean).slice(0, 2).map(p => p[0].toUpperCase()).join('');
const espera = ms => new Promise(r => setTimeout(r, ms));

/* ------------------------------------------------------------------ API */
let pendientes = 0;
const $prog = document.getElementById('progreso');
function progreso(delta) {
  pendientes = Math.max(0, pendientes + delta);
  if (pendientes > 0) { $prog.className = 'progreso'; void $prog.offsetWidth; $prog.className = 'progreso activo'; }
  else { $prog.className = 'progreso fin'; }
}
async function api(ruta, datos) {
  const opts = datos ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(datos) } : {};
  opts.credentials = 'same-origin';
  progreso(1);
  let r;
  try {
    r = await fetch(ruta, opts);
  } catch (e) {
    throw { errores: ['No se pudo conectar con el servidor. Revise su conexión e intente de nuevo.'] };
  } finally { progreso(-1); }
  let j = null;
  try { j = await r.json(); } catch (e) { /* sin JSON */ }
  if (r.status === 401 && !ruta.startsWith('/api/login')) {
    SESION = null; pintarUsuario();
    if (!location.hash.startsWith('#/login')) location.hash = '#/login?volver=' + encodeURIComponent(location.hash.slice(2));
  }
  if (!r.ok) throw (j && j.errores) ? j : { errores: ['Error ' + r.status + ' del servidor.'] };
  return j;
}

/* ------------------------------------------------------------------ toasts y mensajes */
function toast(tipo, titulo, detalle, ms) {
  ms = ms || (tipo === 'error' ? 7000 : 4500);
  const ico = { ok: '✓', error: '!', aviso: '⚠' }[tipo] || 'i';
  const el = document.createElement('div');
  el.className = 'toast ' + tipo;
  el.setAttribute('role', tipo === 'error' ? 'alert' : 'status');
  const cuerpo = Array.isArray(detalle) ? (detalle.length ? '<ul>' + detalle.map(x => '<li>' + esc(x) + '</li>').join('') + '</ul>' : '')
    : (detalle ? '<p>' + esc(detalle) + '</p>' : '');
  el.innerHTML = '<span class="t-ico">' + ico + '</span><div><strong>' + esc(titulo) + '</strong>' + cuerpo + '</div>' +
    '<button class="cerrar" aria-label="Cerrar">×</button><span class="tiempo" style="animation-duration:' + ms + 'ms"></span>';
  const cerrar = () => { el.classList.add('salir'); setTimeout(() => el.remove(), 350); };
  el.querySelector('.cerrar').onclick = cerrar;
  document.getElementById('toasts').appendChild(el);
  setTimeout(cerrar, ms);
}
function mostrarMensaje(el, tipo, titulo, lista) {
  el.innerHTML = '<div class="mensaje ' + tipo + '"><strong>' + esc(titulo) + '</strong>' +
    (lista && lista.length ? '<ul>' + lista.map(x => '<li>' + esc(x) + '</li>').join('') + '</ul>' : '') + '</div>';
}
function sacudir(el) { el.classList.remove('sacudir'); void el.offsetWidth; el.classList.add('sacudir'); }
function datosForm(form) {
  const o = {};
  new FormData(form).forEach((v, k) => { o[k] = typeof v === 'string' ? v.trim() : v; });
  return o;
}
function requeridos(form) {
  let ok = true;
  form.querySelectorAll('[data-req]').forEach(i => {
    const vacio = !String(i.value).trim();
    i.classList.toggle('invalido', vacio);
    if (vacio) ok = false;
  });
  if (!ok) { sacudir(form); toast('error', 'Faltan datos', 'Complete los campos marcados en rojo.'); }
  return ok;
}
function quitarInvalido(form) {
  form.addEventListener('input', e => e.target.classList && e.target.classList.remove('invalido'));
  form.addEventListener('change', e => e.target.classList && e.target.classList.remove('invalido'));
}
function botonCargando(btn, si, texto) {
  if (si) { btn.dataset.txt = btn.innerHTML; btn.disabled = true; btn.innerHTML = '<span class="spinner"></span>' + esc(texto || 'Guardando…'); }
  else { btn.disabled = false; if (btn.dataset.txt) btn.innerHTML = btn.dataset.txt; }
}

/* ------------------------------------------------------------------ animaciones */
function contar(el) {
  const fin = Number(el.dataset.contar) || 0;
  const fmt = FORMATOS[el.dataset.fmt] || FORMATOS.n;
  if (!MOVIMIENTO) { el.textContent = fmt(fin); return; }
  const dur = 1100, t0 = performance.now();
  const paso = t => {
    const p = Math.min(1, (t - t0) / dur), e = 1 - Math.pow(1 - p, 3);
    const v = fin * e;
    el.textContent = p < 1 ? fmt(el.dataset.fmt === 'bs' ? v : Math.round(v * 2) / 2) : fmt(fin);
    if (p < 1) requestAnimationFrame(paso);
  };
  requestAnimationFrame(paso);
}
function animar(raiz) {
  raiz = raiz || $app;
  raiz.querySelectorAll('[data-contar]').forEach(contar);
  requestAnimationFrame(() => requestAnimationFrame(() => {
    raiz.querySelectorAll('[data-ancho]').forEach(el => { el.style.width = el.dataset.ancho + '%'; });
    raiz.querySelectorAll('.dona .seg').forEach(c => {
      c.style.strokeDasharray = c.dataset.dash;
      c.style.strokeDashoffset = c.dataset.off;
    });
    raiz.querySelectorAll('.grafico').forEach(g => {
      const l = g.querySelector('.linea');
      if (l && l.getTotalLength) { const L = l.getTotalLength(); l.style.strokeDasharray = L; l.style.strokeDashoffset = MOVIMIENTO ? L : 0; }
      g.classList.add('listo');
    });
  }));
}
// efecto de onda en botones
document.addEventListener('click', e => {
  const b = e.target.closest('.btn');
  if (!b || !MOVIMIENTO) return;
  const r = b.getBoundingClientRect(), d = Math.max(r.width, r.height);
  const s = document.createElement('span');
  s.className = 'onda';
  s.style.cssText = 'width:' + d + 'px;height:' + d + 'px;left:' + (e.clientX - r.left - d / 2) + 'px;top:' + (e.clientY - r.top - d / 2) + 'px';
  b.appendChild(s);
  setTimeout(() => s.remove(), 650);
});
// tooltip flotante para gráficos
const $tip = document.createElement('div');
$tip.className = 'tip';
document.body.appendChild($tip);
document.addEventListener('mousemove', e => {
  const t = e.target.closest && e.target.closest('[data-tip]');
  if (!t) { $tip.classList.remove('ver'); return; }
  $tip.innerHTML = t.dataset.tip;
  const w = $tip.offsetWidth;
  $tip.style.left = Math.min(window.innerWidth - w - 10, Math.max(10, e.clientX - w / 2)) + 'px';
  $tip.style.top = (e.clientY - 52) + 'px';
  $tip.classList.add('ver');
});

/* ------------------------------------------------------------------ componentes */
function kpi(etq, valor, fmt, det, ico, cls, i) {
  return '<div class="tarjeta kpi elevar esc ' + (cls || '') + '" style="--i:' + (i || 0) + '"><span class="ico">' + (ICO[ico] || '') + '</span>' +
    '<div class="etq">' + esc(etq) + '</div><div class="val" data-contar="' + valor + '" data-fmt="' + fmt + '">' + FORMATOS[fmt](0) + '</div>' +
    '<div class="det">' + det + '</div></div>';
}
function barrasDepartamentos(lista) {
  const max = Math.max(1, ...lista.map(d => d.libras));
  return '<div class="barras">' + lista.map(d =>
    '<div class="barra-fila" data-tip="<b>' + esc(d.departamento) + '</b><br>' + fmtLb(d.libras) + ' · ' + d.hojas_ruta + ' hojas de ruta">' +
    '<span>' + esc(d.departamento) + '</span>' +
    '<div class="pista"><div class="relleno" data-ancho="' + (d.libras * 100 / max).toFixed(1) + '"></div></div>' +
    '<span class="cifra"><strong>' + fmtLb(d.libras) + '</strong><small>' + fmtPct(d.porcentaje) + '</small></span></div>'
  ).join('') + '</div>';
}
function donaInventario(inv) {
  const t = inv.total_en_mercado || 0, r = 70, C = 2 * Math.PI * r;
  const a = t ? inv.sin_vender / t * C : 0, b = t ? inv.vendida_sin_salir / t * C : 0;
  return '<div class="dona-box"><div class="dona"><svg viewBox="0 0 170 170">' +
    '<circle class="fondo" cx="85" cy="85" r="' + r + '"/>' +
    '<circle class="seg" cx="85" cy="85" r="' + r + '" stroke="#2E7D32" style="stroke-dasharray:0 ' + C + '" data-dash="' + a + ' ' + C + '" data-off="0"/>' +
    '<circle class="seg" cx="85" cy="85" r="' + r + '" stroke="#D9A441" style="stroke-dasharray:0 ' + C + ';stroke-dashoffset:0" data-dash="' + b + ' ' + C + '" data-off="' + (-a) + '"/>' +
    '</svg><div class="centro"><strong data-contar="' + t + '" data-fmt="lb">0 lb</strong><small>en mercado<br>≈ ' + fmtTq(inv.taques_equivalentes) + ' taques</small></div></div>' +
    '<div class="inv-lista">' +
    '<div class="inv-item"><span><i class="punto" style="background:#2E7D32"></i>Sin vender (en puestos)</span><strong data-contar="' + inv.sin_vender + '" data-fmt="lb">0 lb</strong></div>' +
    '<div class="inv-item"><span><i class="punto" style="background:#D9A441"></i>Vendida, por despachar</span><strong data-contar="' + inv.vendida_sin_salir + '" data-fmt="lb">0 lb</strong></div>' +
    '<p class="muted" style="margin:0;font-size:.82rem">Saldo físico actual en los mercados: lo que entró y todavía no salió hacia los departamentos.</p>' +
    '</div></div>';
}
function graficoDiario(dias) {
  const W = 640, H = 220, pl = 44, pb = 24, pt = 8, n = dias.length;
  const max = Math.max(1, ...dias.map(d => Math.max(d.libras, d.salidas_lb || 0)));
  const paso = Math.pow(10, Math.floor(Math.log10(max)));
  const tope = Math.ceil(max / paso) * paso;
  const ah = H - pb - pt, slot = (W - pl) / n, bw = slot * 0.62;
  const y = v => pt + ah - v / tope * ah;
  let s = '<svg class="grafico" viewBox="0 0 ' + W + ' ' + H + '" style="height:auto" role="img" aria-label="Entradas y salidas por día">';
  for (let i = 0; i <= 4; i++) {
    const v = tope * i / 4, yy = y(v);
    s += '<line class="guia" x1="' + pl + '" x2="' + W + '" y1="' + yy + '" y2="' + yy + '"/>' +
      '<text class="eje" x="' + (pl - 6) + '" y="' + (yy + 3) + '" text-anchor="end">' + fmtNum(v, 0) + '</text>';
  }
  const pts = [];
  dias.forEach((d, i) => {
    const x = pl + i * slot + (slot - bw) / 2, h = d.libras / tope * ah;
    s += '<rect class="col" style="--i:' + i + '" x="' + x.toFixed(1) + '" y="' + y(d.libras).toFixed(1) + '" width="' + bw.toFixed(1) + '" height="' + Math.max(0, h).toFixed(1) + '" rx="3"/>';
    pts.push([pl + i * slot + slot / 2, y(d.salidas_lb || 0)]);
    if (i % 5 === 0 || i === n - 1) s += '<text class="eje" x="' + (pl + i * slot + slot / 2) + '" y="' + (H - 6) + '" text-anchor="middle">' + fmtFechaCorta(d.fecha) + '</text>';
  });
  s += '<polyline class="linea" points="' + pts.map(p => p[0].toFixed(1) + ',' + p[1].toFixed(1)).join(' ') + '"/>';
  pts.forEach((p, i) => { s += '<circle class="pt" style="--i:' + i + '" cx="' + p[0].toFixed(1) + '" cy="' + p[1].toFixed(1) + '" r="3"/>'; });
  dias.forEach((d, i) => {
    const dia = DIAS[new Date(d.fecha + 'T12:00:00').getDay()];
    s += '<rect class="zona" x="' + (pl + i * slot).toFixed(1) + '" y="' + pt + '" width="' + slot.toFixed(1) + '" height="' + ah + '" data-tip="<b>' + dia + ' ' + fmtFecha(d.fecha) +
      '</b><br>Entradas: ' + fmtLb(d.libras) + ' (' + d.entradas + ')<br>Salidas: ' + fmtLb(d.salidas_lb || 0) + '"/>';
  });
  return s + '</svg><div class="leyenda" style="margin-top:6px"><span><i style="background:#2E7D32"></i>Entradas (lb)</span><span><i style="background:#D9A441;height:3px;vertical-align:3px"></i>Salidas a departamentos (lb)</span></div>';
}
function pasos(actual) {
  const ps = [['entradas', 'Entrada'], ['ventas', 'Venta'], ['salidas', 'Salida'], ['verificar', 'Hoja de ruta']];
  const idx = ps.findIndex(p => p[0] === actual);
  return '<nav class="pasos" aria-label="Circuito">' + ps.map((p, i) =>
    '<a href="#/' + p[0] + '" class="' + (i === idx ? 'activo' : i < idx ? 'hecho' : '') + '"><span class="n">' + (i < idx ? '✓' : i + 1) + '</span><span class="txt">' + p[1] + '</span></a>').join('') + '</nav>';
}
function buscador(id, ph) {
  return '<div class="buscador">' + ICO.buscar + '<input id="' + id + '" type="search" placeholder="' + esc(ph) + '"></div>';
}
function selectorMercado(id, sel, cls) {
  return '<select id="' + id + '"' + (cls ? ' class="' + cls + '"' : '') + '><option value="">Todos los mercados</option>' +
    Object.keys(CONFIG.mercados).map(m => '<option' + (m === sel ? ' selected' : '') + '>' + esc(m) + '</option>').join('') + '</select>';
}
const filaAnim = (i, id, tipo) => ' class="' + (i < 40 ? 'fila-anim' : '') + (ULTIMO_ID[tipo] === id ? ' nuevo' : '') + '" style="--i:' + i + '"';
const esqueleto = h => '<div class="esqueleto" style="height:' + (h || 120) + 'px"></div>';

/* ------------------------------------------------------------------ usuario en la barra */
function pintarUsuario() {
  const z = document.getElementById('zonaUsuario');
  document.querySelectorAll('nav > a[data-priv]').forEach(a => a.classList.toggle('bloq', !SESION));
  if (!SESION) {
    z.innerHTML = '<a class="btn-entrar" href="#/login">Iniciar sesión</a>';
    return;
  }
  z.innerHTML = '<button class="chip-usuario" id="chipU" aria-haspopup="true"><span class="avatar">' + esc(iniciales(SESION.nombre)) + '</span>' +
    '<span>' + esc(SESION.nombre.split(' ')[0]) + '</span> ▾</button>' +
    '<div class="menu-usuario" id="menuU"><div class="cab"><strong>' + esc(SESION.nombre) + '</strong><small>@' + esc(SESION.usuario) + ' · ' + esc(SESION.rol_nombre) + '</small></div>' +
    '<a href="#/cuenta">Mi cuenta y contraseña</a>' + (SESION.rol === 'admin' ? '<a href="#/usuarios">Administrar usuarios</a>' : '') +
    '<button class="salir" id="btnSalir">Cerrar sesión</button></div>';
  const menu = document.getElementById('menuU');
  document.getElementById('chipU').onclick = e => { e.stopPropagation(); menu.classList.toggle('abierto'); };
  document.getElementById('btnSalir').onclick = async () => {
    try { await api('/api/logout', {}); } catch (e) { /* nada */ }
    SESION = null; pintarUsuario();
    toast('ok', 'Sesión cerrada', 'Hasta pronto.');
    location.hash = '#/';
  };
}
document.addEventListener('click', () => { const m = document.getElementById('menuU'); if (m) m.classList.remove('abierto'); });

/* ------------------------------------------------------------------ Login */
async function vistaLogin(params) {
  const volver = params.get('volver') || '';
  if (SESION) { location.hash = '#/' + volver; return; }
  const local = ['localhost', '127.0.0.1'].includes(location.hostname);
  $app.innerHTML = '<div class="login-pantalla">' +
    '<form class="login-tarjeta" id="form" autocomplete="on" novalidate>' +
    '<div class="login-cab"><svg class="hoja-logo" viewBox="0 0 32 32"><path d="M16 2C8 9 6 18 16 30C26 18 24 9 16 2Z" fill="#fff"/></svg>' +
    '<h1>Iniciar sesión</h1><p>Acceso para el personal autorizado de los mercados.</p></div>' +
    '<div class="login-cuerpo">' +
    (volver ? '<div class="mensaje info" style="margin:0 0 6px">Inicie sesión para entrar a <strong>' + esc(volver.split('?')[0]) + '</strong>.</div>' : '') +
    '<label for="usuario">Usuario</label><div class="campo-icono">' + ICO.usuario + '<input id="usuario" name="usuario" autocomplete="username" data-req autofocus></div>' +
    '<label for="clave">Contraseña</label><div class="campo-icono">' + ICO.candado + '<input id="clave" name="clave" type="password" autocomplete="current-password" data-req>' +
    '<button type="button" class="ver-clave" id="verClave">ver</button></div>' +
    '<button class="btn ancho" type="submit">Entrar</button>' +
    '<p class="login-nota">Sin iniciar sesión puede consultar el <a href="#/">panel</a>, los <a href="#/reportes">reportes</a> y <a href="#/verificar">verificar hojas de ruta</a>.' +
    (local ? '<br><br>Instalación local: usuario <code>admin</code>, contraseña <code>admin123</code>.' : '') + '</p>' +
    '</div></form></div>';
  const f = document.getElementById('form');
  quitarInvalido(f);
  document.getElementById('verClave').onclick = e => {
    const c = f.clave; c.type = c.type === 'password' ? 'text' : 'password'; e.target.textContent = c.type === 'password' ? 'ver' : 'ocultar';
  };
  f.onsubmit = async ev => {
    ev.preventDefault();
    if (!requeridos(f)) return;
    const btn = f.querySelector('button[type=submit]');
    botonCargando(btn, true, 'Verificando…');
    try {
      const r = await api('/api/login', datosForm(f));
      SESION = r.usuario; pintarUsuario();
      toast('ok', '¡Bienvenido, ' + SESION.nombre.split(' ')[0] + '!', 'Sesión iniciada como ' + SESION.rol_nombre.toLowerCase() + '.');
      location.hash = '#/' + volver;
    } catch (e) {
      botonCargando(btn, false);
      sacudir(f.querySelector('.login-cuerpo'));
      toast('error', 'No se pudo iniciar sesión', e.errores);
      f.clave.value = ''; f.clave.focus();
    }
  };
}

/* ------------------------------------------------------------------ 1. Panel */
async function vistaPanel() {
  let mercado = '';
  try { mercado = sessionStorage.getItem('panelMercado') || ''; } catch (e) { /* sin almacenamiento */ }
  const hoy = new Date();
  const saludo = hoy.getHours() < 12 ? 'Buenos días' : hoy.getHours() < 19 ? 'Buenas tardes' : 'Buenas noches';
  $app.innerHTML = '<div class="vista">' +
    '<section class="heroe">' + hojasDeco() + '<div class="heroe-texto">' +
    '<div class="chips"><span class="chip-h"><span class="punto-vivo"></span>En línea</span>' +
    '<span class="chip-h">' + DIAS[hoy.getDay()].replace(/^./, c => c.toUpperCase()) + ', ' + fmtFechaLarga(hoyISO()) + '</span>' +
    '<span class="chip-h" id="chipBD">Base de datos…</span></div>' +
    '<h1>' + (SESION ? saludo + ', ' + esc(SESION.nombre.split(' ')[0]) : 'Control de la Hoja de Coca') + '</h1>' +
    '<p>Movimiento de la hoja de coca en los mercados autorizados: lo que entra, lo que se vende y lo que sale hacia cada departamento.</p>' +
    '<div class="acciones-heroe">' +
    (SESION ? '<a class="btn ocre" href="#/entradas">+ Registrar entrada</a><a class="btn claro" href="#/ventas">Vender</a><a class="btn claro" href="#/salidas">Despachar</a>'
      : '<a class="btn ocre" href="#/login">Iniciar sesión</a><a class="btn claro" href="#/verificar">Verificar hoja de ruta</a>') +
    '<span style="flex:1"></span>' + selectorMercado('fMercado', mercado) +
    '</div></div></section>' +
    '<div id="panel"><div class="kpis">' + [1, 2, 3, 4, 5].map(() => esqueleto(108)).join('') + '</div>' + esqueleto(320) + '</div></div>';
  const sel = document.getElementById('fMercado');
  sel.style.cssText = 'width:auto;min-width:210px;background:rgba(255,255,255,.95)';
  sel.onchange = () => { try { sessionStorage.setItem('panelMercado', sel.value); } catch (e) { /* nada */ } vistaPanel(); };

  const r = await api('/api/resumen' + qsString({ mercado }));
  document.getElementById('chipBD').textContent = '🗄 ' + r.base_datos;
  document.getElementById('panel').innerHTML =
    '<div class="kpis">' +
    kpi('Entradas registradas', r.entradas.libras, 'lb', fmtNum(r.entradas.cantidad, 0) + ' ingresos · ' + fmtTq(r.entradas.taques) + ' taques', 'entrada', '', 0) +
    kpi('Vendido', r.ventas.libras, 'lb', fmtBs(r.ventas.monto) + ' · ' + fmtNum(r.ventas.cantidad, 0) + ' ventas', 'venta', '', 1) +
    kpi('Salidas a departamentos', r.salidas.libras, 'lb', fmtNum(r.salidas.hojas_ruta, 0) + ' hojas de ruta emitidas', 'camion', '', 2) +
    kpi('Precio promedio', r.precio_promedio, 'bs', 'por libra vendida', 'precio', 'ocre', 3) +
    kpi('Saldo en mercado', r.inventario.total_en_mercado, 'lb', '≈ ' + fmtTq(r.inventario.taques_equivalentes) + ' taques', 'almacen', 'ocre', 4) +
    '</div>' +
    '<div class="grid-2">' +
    '<div class="tarjeta esc" style="--i:2"><h2>Coca enviada a cada departamento</h2>' + barrasDepartamentos(r.por_departamento) + '</div>' +
    '<div class="tarjeta esc" style="--i:3"><h2>Inventario actual</h2>' + donaInventario(r.inventario) + '</div>' +
    '</div>' +
    '<div class="grid-2">' +
    '<div class="tarjeta esc" style="--i:4"><h2>Entradas y salidas por día <small class="muted" style="font-weight:400">· últimos 30 días</small></h2>' + graficoDiario(r.por_dia) + '</div>' +
    '<div class="tarjeta esc" style="--i:5"><div class="tarjeta-cab"><h2>Últimas hojas de ruta</h2><a href="#/verificar" class="btn mini sec">Verificar</a></div>' +
    '<div class="ultimas" style="margin-top:10px">' + (r.ultimas_salidas.length ? r.ultimas_salidas.map((s, i) =>
      '<a class="ultima esc" style="--i:' + (i + 6) + '" href="#/hoja-ruta/' + esc(s.hoja_ruta) + '"><span class="camion">' + ICO.camion + '</span>' +
      '<span><strong class="codigo">' + esc(s.hoja_ruta) + '</strong><small>' + fmtFecha(s.fecha) + ' · ' + esc(s.mercado.split(' (')[0]) + ' → ' + esc(s.departamento) + '</small></span>' +
      '<strong class="num">' + fmtLb(s.libras) + '</strong></a>').join('') : '<p class="vacio">Todavía no hay salidas.</p>') + '</div></div>' +
    '</div>';
  animar();
}

/* ------------------------------------------------------------------ 2. Entradas */
async function vistaEntradas() {
  const mercados = Object.keys(CONFIG.mercados);
  $app.innerHTML = '<div class="vista">' +
    '<div class="encabezado"><div><h1>Entradas al mercado</h1><p class="sub">Registro de la hoja de coca que ingresa a los mercados autorizados</p></div></div>' +
    pasos('entradas') +
    '<div class="grid-form">' +
    '<form class="tarjeta" id="form" autocomplete="off" novalidate><h2>Nueva entrada</h2>' +
    '<label for="fecha">Fecha</label><input type="date" name="fecha" id="fecha" value="' + CONFIG.hoy + '" max="' + CONFIG.hoy + '" data-req>' +
    '<label for="mercado">Mercado</label><select name="mercado" id="mercado" data-req>' + opciones(mercados, mercados[0]) + '</select>' +
    '<label for="procedencia">Procedencia (provincia)</label><select name="procedencia" id="procedencia" data-req></select>' +
    '<label for="productor">Productor</label><input name="productor" id="productor" placeholder="Nombre completo" data-req>' +
    '<label for="ci">CI del productor</label><input name="ci" id="ci" placeholder="Ej. 1234567 o 1234567-1A" data-req>' +
    '<div class="fila"><div><label for="taques">Taques</label><input type="number" name="taques" id="taques" min="0" step="0.5" value="1" data-req></div>' +
    '<div><label for="libras">Libras <button type="button" class="link-btn" id="recalc">recalcular</button></label>' +
    '<input type="number" name="libras" id="libras" min="0" step="0.5" value="' + CONFIG.libras_por_taque + '" data-req></div></div>' +
    '<div class="ayuda" id="ayudaPeso"></div>' +
    '<label for="observacion">Observación</label><textarea name="observacion" id="observacion" placeholder="Opcional"></textarea>' +
    '<button class="btn ancho" type="submit">Registrar entrada</button>' +
    '<div id="msg"></div></form>' +
    '<div class="tarjeta"><div class="tarjeta-cab"><h2>Entradas registradas <span class="contador" id="cnt"></span></h2>' + buscador('buscar', 'Buscar productor, CI, procedencia, Nº…') + '</div>' +
    '<div class="tabla-box" id="tabla">' + esqueleto(400) + '</div></div>' +
    '</div></div>';

  const f = document.getElementById('form');
  quitarInvalido(f);
  const selM = f.mercado, selP = f.procedencia, inT = f.taques, inL = f.libras;
  let librasEditadas = false;
  const llenarProc = () => { selP.innerHTML = opciones(CONFIG.mercados[selM.value] || [], null, '— Elija la procedencia —'); };
  const verificarPeso = () => {
    const t = parseFloat(inT.value) || 0, l = parseFloat(inL.value) || 0, esp = t * CONFIG.libras_por_taque;
    const a = document.getElementById('ayudaPeso');
    if (t > 0 && l > esp * (1 + CONFIG.tolerancia_peso)) {
      a.className = 'ayuda alerta';
      a.textContent = '⚠ ' + fmtLb(l) + ' supera en más del 20 % lo esperado para ' + fmtTq(t) + ' taques (' + fmtLb(esp) + '). Verifique el peso.';
    } else {
      a.className = 'ayuda';
      a.textContent = '1 taque = ' + CONFIG.libras_por_taque + ' lb (referencial). Esperado: ' + fmtLb(esp) + '. Puede corregir con el peso real.';
    }
  };
  const recalcular = () => { inL.value = (parseFloat(inT.value) || 0) * CONFIG.libras_por_taque; librasEditadas = false; verificarPeso(); };
  selM.onchange = llenarProc;
  inT.oninput = () => { if (!librasEditadas) inL.value = (parseFloat(inT.value) || 0) * CONFIG.libras_por_taque; verificarPeso(); };
  inL.oninput = () => { librasEditadas = true; verificarPeso(); };
  document.getElementById('recalc').onclick = recalcular;
  llenarProc();
  verificarPeso();

  f.onsubmit = async ev => {
    ev.preventDefault();
    if (!requeridos(f)) return;
    const msg = document.getElementById('msg'), btn = f.querySelector('button[type=submit]');
    botonCargando(btn, true);
    try {
      const res = await api('/api/entradas', datosForm(f));
      toast('ok', res.mensaje, 'Ahora puede registrar su venta.');
      if (res.avisos && res.avisos.length) toast('aviso', 'Aviso de peso', res.avisos);
      msg.innerHTML = '<div class="mensaje ok"><strong>' + esc(res.mensaje) + '</strong><br><a href="#/ventas?entrada=' + res.id + '">Registrar una venta de esta entrada →</a></div>';
      ULTIMO_ID.entrada = res.id;
      f.productor.value = ''; f.ci.value = ''; f.observacion.value = ''; f.taques.value = 1; recalcular();
      cargar();
    } catch (e) {
      sacudir(f);
      mostrarMensaje(msg, 'error', 'No se pudo registrar:', e.errores);
      toast('error', 'Revise los datos', e.errores);
    } finally { botonCargando(btn, false); }
  };

  const buscar = document.getElementById('buscar');
  async function cargar() {
    const filas = await api('/api/entradas' + qsString({ q: buscar.value.trim() }));
    document.getElementById('cnt').textContent = '· ' + filas.length + (filas.length >= 500 ? '+' : '');
    document.getElementById('tabla').innerHTML = filas.length ?
      '<table><thead><tr><th>Nº</th><th>Fecha</th><th>Mercado</th><th>Productor</th><th>CI</th><th>Procedencia</th>' +
      '<th class="num">Taques</th><th class="num">Libras</th><th class="num">Sin vender</th><th></th></tr></thead><tbody>' +
      filas.map((e, i) => '<tr' + filaAnim(i, e.id, 'entrada') + '><td>' + e.id + '</td><td>' + fmtFecha(e.fecha) + '</td><td>' + esc(e.mercado.split(' (')[0]) + '</td>' +
        '<td>' + esc(e.productor) + (e.observacion ? ' <span title="' + esc(e.observacion) + '">📝</span>' : '') + '</td><td>' + esc(e.ci) + '</td>' +
        '<td>' + esc(e.procedencia) + '</td><td class="num">' + fmtTq(e.taques) + '</td><td class="num">' + fmtLb(e.libras) + '</td>' +
        '<td class="num"><span class="chip ' + (e.saldo > 0 ? '' : 'cero') + '">' + fmtLb(e.saldo) + '</span></td>' +
        '<td>' + (e.saldo > 0 ? '<a class="btn mini sec" href="#/ventas?entrada=' + e.id + '">Vender</a>' : '') + '</td></tr>').join('') +
      '</tbody></table>' : '<p class="vacio">No hay entradas que coincidan con la búsqueda.</p>';
  }
  buscar.oninput = debounce(cargar, 280);
  await cargar();
}

/* ------------------------------------------------------------------ 3. Ventas */
async function vistaVentas(params) {
  $app.innerHTML = '<div class="vista">' +
    '<div class="encabezado"><div><h1>Ventas</h1><p class="sub">Venta de hoja de coca a comerciantes, a partir de una entrada con saldo</p></div></div>' +
    pasos('ventas') +
    '<div class="grid-form">' +
    '<form class="tarjeta" id="form" autocomplete="off" novalidate><h2>Nueva venta</h2>' +
    '<label for="fecha">Fecha</label><input type="date" name="fecha" id="fecha" value="' + CONFIG.hoy + '" max="' + CONFIG.hoy + '" data-req>' +
    '<label for="entrada_id">Entrada (lote) con saldo</label><select name="entrada_id" id="entrada_id" data-req><option value="">Cargando…</option></select>' +
    '<div class="ayuda" id="saldoInfo"></div><div class="saldo-barra" id="saldoBarra" hidden><div style="width:0"></div></div>' +
    '<label for="comprador">Comprador</label><input name="comprador" id="comprador" placeholder="Nombre completo" data-req>' +
    '<label for="ci_comprador">CI del comprador</label><input name="ci_comprador" id="ci_comprador" placeholder="Ej. 4567890" data-req>' +
    '<div class="fila"><div><label for="libras">Libras <button type="button" class="link-btn" id="todo">todo el saldo</button></label>' +
    '<input type="number" name="libras" id="libras" min="0" step="0.5" data-req></div>' +
    '<div><label for="precio_libra">Precio por libra (Bs)</label><input type="number" name="precio_libra" id="precio_libra" min="0" step="0.5" value="40" data-req></div></div>' +
    '<div class="total-vivo"><span>Total a pagar</span><strong id="total">Bs 0,00</strong></div>' +
    '<button class="btn ancho" type="submit">Registrar venta</button>' +
    '<div id="msg"></div></form>' +
    '<div class="tarjeta"><div class="tarjeta-cab"><h2>Ventas registradas <span class="contador" id="cnt"></span></h2>' + buscador('buscar', 'Buscar comprador, CI, productor, Nº…') + '</div>' +
    '<div class="tabla-box" id="tabla">' + esqueleto(400) + '</div></div>' +
    '</div></div>';

  const f = document.getElementById('form');
  quitarInvalido(f);
  let entradas = [];
  const sel = f.entrada_id, info = document.getElementById('saldoInfo'), barra = document.getElementById('saldoBarra');
  const totalEl = document.getElementById('total');
  const actual = () => entradas.find(e => String(e.id) === sel.value);
  const actualizarTotal = () => {
    const t = (parseFloat(f.libras.value) || 0) * (parseFloat(f.precio_libra.value) || 0);
    const nuevo = fmtBs(t);
    if (totalEl.textContent !== nuevo) { totalEl.textContent = nuevo; totalEl.classList.add('pulso'); setTimeout(() => totalEl.classList.remove('pulso'), 150); }
    const e = actual(), l = parseFloat(f.libras.value) || 0;
    if (e) {
      barra.hidden = false;
      barra.classList.toggle('exceso', l > e.saldo);
      barra.firstChild.style.width = Math.min(100, l / e.saldo * 100) + '%';
      if (l > e.saldo) { info.className = 'ayuda alerta'; info.textContent = '⚠ La cantidad supera el saldo: quedan ' + fmtLb(e.saldo) + ' sin vender.'; }
      else { info.className = 'ayuda'; info.innerHTML = 'Quedan <strong>' + fmtLb(e.saldo) + '</strong> sin vender · ' + esc(e.procedencia) + ' · ' + esc(e.mercado); }
    } else { barra.hidden = true; info.className = 'ayuda'; info.textContent = ''; }
  };
  async function cargarEntradas(preferida) {
    entradas = await api('/api/entradas?con_saldo=1');
    sel.innerHTML = '<option value="">— Elija una entrada (' + entradas.length + ' con saldo) —</option>' + entradas.map(e =>
      '<option value="' + e.id + '">Nº ' + e.id + ' · ' + fmtFecha(e.fecha) + ' · ' + esc(e.productor) + ' (' + esc(e.procedencia) + ') — quedan ' + fmtLb(e.saldo) + '</option>').join('');
    if (preferida && entradas.some(e => String(e.id) === String(preferida))) sel.value = preferida;
    actualizarTotal();
  }
  sel.onchange = actualizarTotal;
  f.libras.oninput = actualizarTotal;
  f.precio_libra.oninput = actualizarTotal;
  document.getElementById('todo').onclick = () => { const e = actual(); if (e) { f.libras.value = e.saldo; actualizarTotal(); } };

  f.onsubmit = async ev => {
    ev.preventDefault();
    if (!requeridos(f)) return;
    const msg = document.getElementById('msg'), btn = f.querySelector('button[type=submit]');
    botonCargando(btn, true);
    try {
      const res = await api('/api/ventas', datosForm(f));
      toast('ok', res.mensaje, 'Total: ' + fmtBs(res.total));
      msg.innerHTML = '<div class="mensaje ok"><strong>' + esc(res.mensaje) + '</strong> Total ' + fmtBs(res.total) + '<br><a href="#/salidas?venta=' + res.id + '">Despachar esta venta a un departamento →</a></div>';
      ULTIMO_ID.venta = res.id;
      f.comprador.value = ''; f.ci_comprador.value = ''; f.libras.value = '';
      await cargarEntradas(sel.value);
      cargar();
    } catch (e) {
      sacudir(f);
      mostrarMensaje(msg, 'error', 'No se pudo registrar:', e.errores);
      toast('error', 'Venta rechazada', e.errores);
    } finally { botonCargando(btn, false); }
  };

  const buscar = document.getElementById('buscar');
  async function cargar() {
    const filas = await api('/api/ventas' + qsString({ q: buscar.value.trim() }));
    document.getElementById('cnt').textContent = '· ' + filas.length + (filas.length >= 500 ? '+' : '');
    document.getElementById('tabla').innerHTML = filas.length ?
      '<table><thead><tr><th>Nº</th><th>Fecha</th><th>Entrada</th><th>Comprador</th><th>CI</th><th class="num">Libras</th>' +
      '<th class="num">Precio/lb</th><th class="num">Total</th><th class="num">Sin despachar</th><th></th></tr></thead><tbody>' +
      filas.map((v, i) => '<tr' + filaAnim(i, v.id, 'venta') + '><td>' + v.id + '</td><td>' + fmtFecha(v.fecha) + '</td><td title="' + esc(v.productor + ' · ' + v.procedencia) + '">Nº ' + v.entrada_id + '</td>' +
        '<td>' + esc(v.comprador) + '</td><td>' + esc(v.ci_comprador) + '</td><td class="num">' + fmtLb(v.libras) + '</td>' +
        '<td class="num">' + fmtBs(v.precio_libra) + '</td><td class="num">' + fmtBs(v.total) + '</td>' +
        '<td class="num"><span class="chip ' + (v.saldo > 0 ? 'ocre' : 'cero') + '">' + fmtLb(v.saldo) + '</span></td>' +
        '<td>' + (v.saldo > 0 ? '<a class="btn mini sec" href="#/salidas?venta=' + v.id + '">Despachar</a>' : '') + '</td></tr>').join('') +
      '</tbody></table>' : '<p class="vacio">No hay ventas que coincidan con la búsqueda.</p>';
  }
  buscar.oninput = debounce(cargar, 280);
  await cargarEntradas(params.get('entrada'));
  await cargar();
}

/* ------------------------------------------------------------------ 4. Salidas */
async function vistaSalidas(params) {
  $app.innerHTML = '<div class="vista">' +
    '<div class="encabezado"><div><h1>Salidas a departamentos</h1><p class="sub">Despacho de la coca vendida hacia cada departamento, con hoja de ruta</p></div></div>' +
    pasos('salidas') +
    '<div class="grid-form">' +
    '<form class="tarjeta" id="form" autocomplete="off" novalidate><h2>Nueva salida</h2>' +
    '<label for="fecha">Fecha</label><input type="date" name="fecha" id="fecha" value="' + CONFIG.hoy + '" max="' + CONFIG.hoy + '" data-req>' +
    '<label for="venta_id">Venta con saldo por despachar</label><select name="venta_id" id="venta_id" data-req><option value="">Cargando…</option></select>' +
    '<div class="ayuda" id="saldoInfo"></div><div class="saldo-barra" id="saldoBarra" hidden><div style="width:0"></div></div>' +
    '<label for="departamento">Departamento destino</label><select name="departamento" id="departamento" data-req>' + opciones(CONFIG.departamentos, null, '— Elija el destino —') + '</select>' +
    '<div class="fila"><div><label for="libras">Libras <button type="button" class="link-btn" id="todo">todo</button></label>' +
    '<input type="number" name="libras" id="libras" min="0" step="0.5" data-req></div>' +
    '<div><label for="placa">Placa del vehículo</label><input name="placa" id="placa" placeholder="Ej. 2345-KTR" style="text-transform:uppercase" data-req></div></div>' +
    '<button class="btn ancho" type="submit">Registrar salida y emitir hoja de ruta</button>' +
    '<div id="msg"></div></form>' +
    '<div class="tarjeta"><div class="tarjeta-cab"><h2>Salidas registradas <span class="contador" id="cnt"></span></h2>' +
    '<select id="fDepto" style="max-width:240px">' + opciones(CONFIG.departamentos, null, 'Todos los departamentos') + '</select></div>' +
    '<div class="tabla-box" id="tabla">' + esqueleto(400) + '</div></div>' +
    '</div></div>';

  const f = document.getElementById('form');
  quitarInvalido(f);
  const sel = f.venta_id, info = document.getElementById('saldoInfo'), barra = document.getElementById('saldoBarra');
  let ventas = [];
  const actual = () => ventas.find(v => String(v.id) === sel.value);
  const actualizar = () => {
    const v = actual(), l = parseFloat(f.libras.value) || 0;
    if (!v) { info.textContent = ''; info.className = 'ayuda'; barra.hidden = true; return; }
    barra.hidden = false;
    barra.classList.toggle('exceso', l > v.saldo);
    barra.firstChild.style.width = Math.min(100, l / v.saldo * 100) + '%';
    if (l > v.saldo) { info.className = 'ayuda alerta'; info.textContent = '⚠ Supera lo pendiente: quedan ' + fmtLb(v.saldo) + ' por despachar.'; }
    else { info.className = 'ayuda'; info.innerHTML = 'Quedan <strong>' + fmtLb(v.saldo) + '</strong> por despachar · comprador ' + esc(v.comprador); }
  };

  const fDepto = document.getElementById('fDepto');
  async function cargar() {
    const filas = await api('/api/salidas' + qsString({ departamento: fDepto.value }));
    const tot = filas.reduce((s, x) => s + x.libras, 0);
    document.getElementById('cnt').textContent = '· ' + filas.length + (filas.length >= 500 ? '+' : '');
    document.getElementById('tabla').innerHTML = filas.length ?
      '<table><thead><tr><th>Hoja de ruta</th><th>Fecha</th><th>Destino</th><th class="num">Libras</th><th>Placa</th><th>Comprador</th><th>Venta</th></tr></thead><tbody>' +
      filas.map((s, i) => '<tr' + filaAnim(i, s.id, 'salida') + '><td><a class="codigo" href="#/hoja-ruta/' + esc(s.hoja_ruta) + '">' + esc(s.hoja_ruta) + '</a></td><td>' + fmtFecha(s.fecha) + '</td>' +
        '<td><strong>' + esc(s.departamento) + '</strong></td><td class="num">' + fmtLb(s.libras) + '</td><td>' + esc(s.placa) + '</td>' +
        '<td>' + esc(s.comprador) + '</td><td>Nº ' + s.venta_id + '</td></tr>').join('') +
      '</tbody><tfoot><tr><td colspan="3">' + filas.length + ' salidas' + (filas.length >= 500 ? ' (últimas 500)' : '') + '</td><td class="num">' + fmtLb(tot) + '</td><td colspan="3"></td></tr></tfoot></table>'
      : '<p class="vacio">No hay salidas para este departamento.</p>';
  }
  fDepto.onchange = cargar;

  ventas = await api('/api/ventas?con_saldo=1');
  sel.innerHTML = '<option value="">— Elija una venta (' + ventas.length + ' pendientes) —</option>' + ventas.map(v =>
    '<option value="' + v.id + '">Venta Nº ' + v.id + ' · ' + fmtFecha(v.fecha) + ' · ' + esc(v.comprador) + ' — quedan ' + fmtLb(v.saldo) + '</option>').join('');
  const pref = params.get('venta');
  if (pref && ventas.some(v => String(v.id) === pref)) { sel.value = pref; f.libras.value = actual().saldo; }
  sel.onchange = () => { const v = actual(); if (v) f.libras.value = v.saldo; actualizar(); };
  f.libras.oninput = actualizar;
  document.getElementById('todo').onclick = () => { const v = actual(); if (v) { f.libras.value = v.saldo; actualizar(); } };
  actualizar();

  f.onsubmit = async ev => {
    ev.preventDefault();
    if (!requeridos(f)) return;
    const msg = document.getElementById('msg'), btn = f.querySelector('button[type=submit]');
    botonCargando(btn, true, 'Emitiendo hoja de ruta…');
    try {
      const res = await api('/api/salidas', datosForm(f));
      toast('ok', 'Hoja de ruta emitida', res.hoja_ruta + ' · ' + f.departamento.value);
      location.hash = '#/hoja-ruta/' + encodeURIComponent(res.hoja_ruta);
    } catch (e) {
      sacudir(f);
      mostrarMensaje(msg, 'error', 'No se pudo registrar:', e.errores);
      toast('error', 'Salida rechazada', e.errores);
      botonCargando(btn, false);
    }
  };
  await cargar();
}

/* ------------------------------------------------------------------ 5. Hoja de ruta */
async function vistaHojaRuta(codigo) {
  $app.innerHTML = '<div class="cargador"><div class="hoja-giro"></div><p>Cargando hoja de ruta…</p></div>';
  let h;
  try {
    h = await api('/api/hoja-ruta/' + encodeURIComponent(codigo));
  } catch (e) {
    $app.innerHTML = '<div class="verif-wrap"><div class="resultado invalida"><div class="sello-wrap"><span class="icono">✕</span><span class="sello">NO ENCONTRADA</span></div><p>' +
      esc((e.errores || [])[0]) + '</p><a class="btn sec" href="#/verificar">Ir a verificar</a></div></div>';
    return;
  }
  const urlVerif = location.origin + '/#/verificar/' + h.hoja_ruta;
  $app.innerHTML =
    '<div class="acciones no-print"><button class="btn" id="imprimir">🖨 Imprimir</button>' +
    '<a class="btn sec" href="#/verificar/' + esc(h.hoja_ruta) + '">Verificar</a>' + (SESION ? '<a class="btn sec" href="#/salidas">Nueva salida</a>' : '') + '</div>' +
    '<article class="hoja">' +
    '<span class="sello-emitida">EMITIDA</span>' +
    '<div class="hoja-cab"><div><div class="inst">Sistema de Control de Comercialización de la Hoja de Coca</div>' +
    '<h1>HOJA DE RUTA</h1><div class="cod">' + esc(h.hoja_ruta) + '</div>' +
    '<div class="ayuda">Emitida el ' + fmtFechaLarga(h.fecha) + ' · Mercado ' + esc(h.mercado) + '</div></div>' +
    '<div class="qr" id="qr"></div></div>' +
    '<div class="destaque"><div><div class="etq">Departamento de destino</div><div class="grande">' + esc(h.departamento).toUpperCase() + '</div><div class="det">Vehículo placa ' + esc(h.placa) + '</div></div>' +
    '<div><div class="etq">Cantidad autorizada</div><div class="grande">' + fmtLb(h.libras) + '</div><div class="det">≈ ' + fmtTq(h.libras / CONFIG.libras_por_taque) + ' taques</div></div></div>' +
    '<div class="datos">' +
    '<section><h3>Comprador / transportista</h3><dl class="dl"><dt>Nombre</dt><dd>' + esc(h.comprador) + '</dd><dt>CI</dt><dd>' + esc(h.ci_comprador) + '</dd>' +
    '<dt>Placa</dt><dd>' + esc(h.placa) + '</dd><dt>Venta Nº</dt><dd>' + h.venta_id + ' (' + fmtFecha(h.fecha_venta) + ')</dd>' +
    '<dt>Precio/lb</dt><dd>' + fmtBs(h.precio_libra) + '</dd></dl></section>' +
    '<section><h3>Origen de la hoja</h3><dl class="dl"><dt>Mercado</dt><dd>' + esc(h.mercado) + '</dd><dt>Procedencia</dt><dd>' + esc(h.procedencia) + '</dd>' +
    '<dt>Productor</dt><dd>' + esc(h.productor) + '</dd><dt>CI productor</dt><dd>' + esc(h.ci_productor) + '</dd>' +
    '<dt>Entrada Nº</dt><dd>' + h.entrada_id + ' (' + fmtFecha(h.fecha_entrada) + ')</dd></dl></section>' +
    '</div>' +
    (h.registrado_por ? '<p class="ayuda" style="margin:0">Registrado por: ' + esc(h.registrado_por) + '</p>' : '') +
    '<div class="firmas"><div>Responsable del mercado</div><div>Comprador</div><div>Control en ruta</div></div>' +
    '<div class="hoja-pie">Verifique la autenticidad escaneando el código QR o ingresando el código en ' + esc(location.origin) + '/#/verificar. ' +
    'Documento válido solo para el destino y la cantidad indicados.</div>' +
    '</article>';
  document.getElementById('imprimir').onclick = () => window.print();
  const qr = document.getElementById('qr');
  if (window.QRCode) {
    try { new QRCode(qr, { text: urlVerif, width: 150, height: 150, correctLevel: QRCode.CorrectLevel.M }); }
    catch (e) { qr.innerHTML = '<div class="qr-texto">' + esc(h.hoja_ruta) + '<br><br>' + esc(urlVerif) + '</div>'; }
  } else {
    qr.innerHTML = '<div class="qr-texto"><strong>Código:</strong><br>' + esc(h.hoja_ruta) + '<br><br>' + esc(urlVerif) + '<br><small>(QR no disponible sin internet)</small></div>';
  }
}

/* ------------------------------------------------------------------ 6. Verificar */
async function vistaVerificar(codigo) {
  $app.innerHTML = '<div class="vista verif-wrap">' +
    '<div><h1>Verificar hoja de ruta</h1><p class="sub">Para puestos de control: ingrese el código impreso o escanee el QR con la cámara del celular</p></div>' +
    (SESION ? pasos('verificar') : '') +
    '<form class="verif-form" id="form"><input id="codigo" placeholder="HR-' + new Date().getFullYear() + '-000001" value="' + esc(codigo || '') + '" autocomplete="off" aria-label="Código de hoja de ruta">' +
    '<button class="btn" type="submit">' + ICO.qr.replace('<svg', '<svg width="18" height="18"') + ' Verificar</button></form><div id="res"></div></div>';
  const f = document.getElementById('form'), inp = document.getElementById('codigo');
  f.onsubmit = ev => {
    ev.preventDefault();
    const c = inp.value.trim().toUpperCase();
    if (!c) { sacudir(f); return; }
    if ('#/verificar/' + encodeURIComponent(c) === location.hash) enrutar(); else location.hash = '#/verificar/' + encodeURIComponent(c);
  };
  if (!codigo) { inp.focus(); return; }
  const res = document.getElementById('res');
  res.innerHTML = '<div class="escaner">Verificando ' + esc(codigo) + '…</div>';
  const [r] = await Promise.allSettled([api('/api/hoja-ruta/' + encodeURIComponent(codigo)), espera(MOVIMIENTO ? 700 : 0)]);
  if (r.status === 'fulfilled') {
    const h = r.value;
    res.innerHTML = '<div class="resultado valida"><div class="sello-wrap"><span class="icono">✓</span><span class="sello">HOJA DE RUTA VÁLIDA</span></div>' +
      '<dl class="dl"><dt>Código</dt><dd class="codigo">' + esc(h.hoja_ruta) + '</dd><dt>Fecha de emisión</dt><dd>' + fmtFechaLarga(h.fecha) + '</dd>' +
      '<dt>Destino</dt><dd style="font-size:1.3rem">' + esc(h.departamento) + '</dd><dt>Cantidad</dt><dd style="font-size:1.3rem">' + fmtLb(h.libras) + '</dd>' +
      '<dt>Comprador</dt><dd>' + esc(h.comprador) + ' · CI ' + esc(h.ci_comprador) + '</dd><dt>Placa</dt><dd>' + esc(h.placa) + '</dd>' +
      '<dt>Origen</dt><dd>' + esc(h.mercado) + ' · procedencia ' + esc(h.procedencia) + '</dd></dl>' +
      '<p class="no-print" style="margin-bottom:0"><a href="#/hoja-ruta/' + esc(h.hoja_ruta) + '">Ver documento completo →</a></p></div>';
  } else {
    res.innerHTML = '<div class="resultado invalida"><div class="sello-wrap"><span class="icono">✕</span><span class="sello">NO VÁLIDA</span></div>' +
      '<p>El código <strong class="codigo">' + esc(codigo) + '</strong> no corresponde a ninguna hoja de ruta emitida por el sistema.</p>' +
      '<p style="margin-bottom:0">Retenga la carga y comunique a la autoridad competente.</p></div>';
  }
}

/* ------------------------------------------------------------------ 7. Reportes */
async function vistaReportes() {
  let filtros = null;
  try { filtros = JSON.parse(sessionStorage.getItem('filtrosRep') || 'null'); } catch (e) { filtros = null; }
  if (!filtros) {
    const d = new Date(); d.setDate(d.getDate() - 59);
    filtros = { desde: isoLocal(d), hasta: hoyISO(), mercado: '' };
  }
  $app.innerHTML = '<div class="vista">' +
    '<div><h1>Reportes</h1><p class="sub">Movimiento por departamento, por mes y por procedencia</p></div>' +
    '<form class="tarjeta filtros" id="form" style="margin-bottom:18px">' +
    '<div><label for="desde">Desde</label><input type="date" id="desde" value="' + filtros.desde + '"></div>' +
    '<div><label for="hasta">Hasta</label><input type="date" id="hasta" value="' + filtros.hasta + '"></div>' +
    '<div style="min-width:220px"><label for="fMercado">Mercado</label>' + selectorMercado('fMercado', filtros.mercado) + '</div>' +
    '<button class="btn" type="submit">Aplicar</button>' +
    '<span style="flex:1"></span>' +
    '<a class="btn ocre" id="csvDep">⬇ CSV departamentos</a>' + (SESION ? '<a class="btn ocre" id="csvSal">⬇ CSV salidas</a>' : '') +
    '</form><div id="rep">' + esqueleto(110) + '<br>' + esqueleto(360) + '</div></div>';

  const f = document.getElementById('form');
  f.onsubmit = ev => {
    ev.preventDefault();
    try { sessionStorage.setItem('filtrosRep', JSON.stringify({ desde: f.desde.value, hasta: f.hasta.value, mercado: document.getElementById('fMercado').value })); } catch (e) { /* nada */ }
    vistaReportes();
  };
  const q = qsString(filtros);
  document.getElementById('csvDep').href = '/api/exportar/departamentos.csv' + q;
  if (SESION) document.getElementById('csvSal').href = '/api/exportar/salidas.csv' + q;

  const r = await api('/api/resumen' + q);
  const totS = r.salidas.libras;
  const tot = { e: 0, v: 0, s: 0, m: 0, h: 0 };
  r.por_mes.forEach(m => { tot.e += m.entradas_lb; tot.v += m.ventas_lb; tot.s += m.salidas_lb; tot.m += m.monto; tot.h += m.hojas_ruta; });
  document.getElementById('rep').innerHTML =
    '<div class="kpis">' +
    kpi('Entradas', r.entradas.libras, 'lb', fmtNum(r.entradas.cantidad, 0) + ' ingresos', 'entrada', '', 0) +
    kpi('Ventas', r.ventas.libras, 'lb', fmtBs(r.ventas.monto), 'venta', '', 1) +
    kpi('Salidas', totS, 'lb', fmtNum(r.salidas.hojas_ruta, 0) + ' hojas de ruta', 'camion', '', 2) +
    kpi('Precio promedio', r.precio_promedio, 'bs', 'por libra', 'precio', 'ocre', 3) +
    '</div>' +
    '<div class="grid-iguales">' +
    '<div class="tarjeta esc" style="--i:2"><h2>Salidas por departamento</h2><div class="tabla-box" style="margin-top:0"><table><thead><tr><th>Departamento</th><th class="num">Libras</th>' +
    '<th class="num">Taques eq.</th><th class="num">Hojas</th><th class="num">%</th></tr></thead><tbody>' +
    r.por_departamento.map((d, i) => '<tr class="fila-anim" style="--i:' + i + '"><td>' + esc(d.departamento) + '</td><td class="num">' + fmtLb(d.libras) + '</td><td class="num">' +
      fmtTq(d.libras / CONFIG.libras_por_taque) + '</td><td class="num">' + d.hojas_ruta + '</td><td class="num">' + fmtPct(d.porcentaje) + '</td></tr>').join('') +
    '</tbody><tfoot><tr><td>Total</td><td class="num">' + fmtLb(totS) + '</td><td class="num">' + fmtTq(totS / CONFIG.libras_por_taque) +
    '</td><td class="num">' + r.salidas.hojas_ruta + '</td><td class="num">' + (totS ? '100 %' : '0 %') + '</td></tr></tfoot></table></div></div>' +
    '<div class="tarjeta esc" style="--i:3"><h2>Distribución por departamento</h2>' + barrasDepartamentos(r.por_departamento) + '</div>' +
    '</div>' +
    '<div class="tarjeta esc" style="--i:4;margin-bottom:18px"><h2>Movimiento por mes</h2><div class="tabla-box" style="margin-top:0"><table><thead><tr><th>Mes</th>' +
    '<th class="num">Entradas</th><th class="num">Ventas</th><th class="num">Salidas</th><th class="num">Hojas de ruta</th><th class="num">Monto vendido</th></tr></thead><tbody>' +
    (r.por_mes.length ? r.por_mes.map((m, i) => '<tr class="fila-anim" style="--i:' + i + '"><td>' + fmtMes(m.mes) + '</td><td class="num">' + fmtLb(m.entradas_lb) + '</td><td class="num">' + fmtLb(m.ventas_lb) +
      '</td><td class="num">' + fmtLb(m.salidas_lb) + '</td><td class="num">' + m.hojas_ruta + '</td><td class="num">' + fmtBs(m.monto) + '</td></tr>').join('')
      : '<tr><td colspan="6" class="vacio">Sin movimientos en el período.</td></tr>') +
    '</tbody><tfoot><tr><td>Total</td><td class="num">' + fmtLb(tot.e) + '</td><td class="num">' + fmtLb(tot.v) + '</td><td class="num">' + fmtLb(tot.s) +
    '</td><td class="num">' + tot.h + '</td><td class="num">' + fmtBs(tot.m) + '</td></tr></tfoot></table></div></div>' +
    '<div class="tarjeta esc" style="--i:5"><h2>Entradas por procedencia</h2><div class="tabla-box" style="margin-top:0"><table><thead><tr><th>Mercado</th><th>Procedencia</th>' +
    '<th class="num">Ingresos</th><th class="num">Taques</th><th class="num">Libras</th><th class="num">%</th></tr></thead><tbody>' +
    (r.por_procedencia.length ? r.por_procedencia.map((p, i) => '<tr class="fila-anim" style="--i:' + i + '"><td>' + esc(p.mercado) + '</td><td>' + esc(p.procedencia) + '</td><td class="num">' + p.entradas +
      '</td><td class="num">' + fmtTq(p.taques) + '</td><td class="num">' + fmtLb(p.libras) + '</td><td class="num">' + fmtPct(p.porcentaje) + '</td></tr>').join('')
      : '<tr><td colspan="6" class="vacio">Sin entradas en el período.</td></tr>') +
    '</tbody></table></div></div>';
  animar();
}

/* ------------------------------------------------------------------ 8. Usuarios (administrador) */
async function vistaUsuarios() {
  if (SESION.rol !== 'admin') { $app.innerHTML = '<div class="mensaje error">Solo un administrador puede ver esta página.</div>'; return; }
  $app.innerHTML = '<div class="vista">' +
    '<div><h1>Usuarios</h1><p class="sub">Personal autorizado para registrar entradas, ventas y salidas</p></div>' +
    '<div class="grid-form">' +
    '<form class="tarjeta" id="form" autocomplete="off" novalidate><h2>Nuevo usuario</h2>' +
    '<label for="nombre">Nombre completo</label><input id="nombre" name="nombre" data-req>' +
    '<label for="usuario">Usuario</label><input id="usuario" name="usuario" placeholder="ej. jmamani" data-req autocapitalize="off">' +
    '<div class="ayuda">Minúsculas, números, punto o guion bajo (3 a 30).</div>' +
    '<label for="clave">Contraseña inicial</label><input id="clave" name="clave" type="text" data-req>' +
    '<div class="ayuda">Mínimo 6 caracteres. El usuario puede cambiarla en «Mi cuenta».</div>' +
    '<label for="rol">Rol</label><select id="rol" name="rol"><option value="operador">Operador (registra movimientos)</option><option value="admin">Administrador (además gestiona usuarios)</option></select>' +
    '<button class="btn ancho" type="submit">Crear usuario</button><div id="msg"></div></form>' +
    '<div class="tarjeta"><h2>Usuarios registrados</h2><div class="tabla-box" id="tabla">' + esqueleto(240) + '</div></div>' +
    '</div></div>';
  const f = document.getElementById('form');
  quitarInvalido(f);
  f.clave.value = Math.random().toString(36).slice(2, 10);
  async function cargar() {
    const us = await api('/api/usuarios');
    document.getElementById('tabla').innerHTML = '<table><thead><tr><th>Usuario</th><th>Nombre</th><th>Rol</th><th>Creado</th><th>Activo</th></tr></thead><tbody>' +
      us.map((u, i) => '<tr class="fila-anim' + (ULTIMO_ID.usuario === u.id ? ' nuevo' : '') + '" style="--i:' + i + '"><td><span class="avatar" style="display:inline-grid;width:26px;height:26px;font-size:.72rem;vertical-align:middle;margin-right:6px">' + esc(iniciales(u.nombre)) + '</span>@' + esc(u.usuario) + '</td>' +
        '<td>' + esc(u.nombre) + '</td><td><span class="rol ' + u.rol + '">' + esc(u.rol_nombre) + '</span></td><td>' + fmtFecha((u.creado || '').slice(0, 10)) + '</td>' +
        '<td><label class="interruptor" title="' + (u.id === SESION.id ? 'Es su propio usuario' : 'Activar / desactivar') + '"><input type="checkbox" data-id="' + u.id + '"' + (u.activo ? ' checked' : '') + (u.id === SESION.id ? ' disabled' : '') + '><span></span></label></td></tr>').join('') +
      '</tbody></table>';
    document.querySelectorAll('.interruptor input').forEach(ch => {
      ch.onchange = async () => {
        try {
          const r = await api('/api/usuarios/' + ch.dataset.id + '/estado', { activo: ch.checked });
          toast('ok', r.mensaje);
        } catch (e) { ch.checked = !ch.checked; toast('error', 'No se pudo cambiar', e.errores); }
      };
    });
  }
  f.onsubmit = async ev => {
    ev.preventDefault();
    if (!requeridos(f)) return;
    const btn = f.querySelector('button[type=submit]'), msg = document.getElementById('msg');
    const datos = datosForm(f);
    botonCargando(btn, true);
    try {
      const r = await api('/api/usuarios', datos);
      ULTIMO_ID.usuario = r.id;
      toast('ok', r.mensaje, 'Contraseña inicial: ' + datos.clave);
      msg.innerHTML = '<div class="mensaje ok"><strong>' + esc(r.mensaje) + '</strong><br>Entregue estos datos: usuario <code>' + esc(datos.usuario) + '</code>, contraseña <code>' + esc(datos.clave) + '</code></div>';
      f.nombre.value = ''; f.usuario.value = ''; f.clave.value = Math.random().toString(36).slice(2, 10);
      cargar();
    } catch (e) {
      sacudir(f); mostrarMensaje(msg, 'error', 'No se pudo crear:', e.errores);
    } finally { botonCargando(btn, false); }
  };
  await cargar();
}

/* ------------------------------------------------------------------ 9. Mi cuenta */
async function vistaCuenta() {
  $app.innerHTML = '<div class="vista" style="max-width:520px;margin:0 auto">' +
    '<div><h1>Mi cuenta</h1><p class="sub">@' + esc(SESION.usuario) + ' · ' + esc(SESION.rol_nombre) + '</p></div>' +
    '<form class="tarjeta" id="form" novalidate><h2>Cambiar contraseña</h2>' +
    '<label for="actual">Contraseña actual</label><input id="actual" name="actual" type="password" autocomplete="current-password" data-req>' +
    '<label for="nueva">Nueva contraseña</label><input id="nueva" name="nueva" type="password" autocomplete="new-password" data-req>' +
    '<label for="repite">Repita la nueva contraseña</label><input id="repite" type="password" autocomplete="new-password" data-req>' +
    '<button class="btn ancho" type="submit">Guardar contraseña</button><div id="msg"></div></form></div>';
  const f = document.getElementById('form');
  quitarInvalido(f);
  f.onsubmit = async ev => {
    ev.preventDefault();
    if (!requeridos(f)) return;
    const msg = document.getElementById('msg');
    if (f.nueva.value !== f.repite.value) { f.repite.classList.add('invalido'); sacudir(f); mostrarMensaje(msg, 'error', 'Las contraseñas nuevas no coinciden.'); return; }
    const btn = f.querySelector('button[type=submit]');
    botonCargando(btn, true);
    try {
      const r = await api('/api/clave', { actual: f.actual.value, nueva: f.nueva.value });
      toast('ok', r.mensaje); f.reset(); msg.innerHTML = '';
    } catch (e) { sacudir(f); mostrarMensaje(msg, 'error', 'No se pudo cambiar:', e.errores); }
    finally { botonCargando(btn, false); }
  };
}

/* ------------------------------------------------------------------ enrutador */
async function enrutar() {
  const h = location.hash.replace(/^#\/?/, '');
  const [ruta, query] = h.split('?');
  const partes = ruta.split('/').map(p => { try { return decodeURIComponent(p); } catch (e) { return p; } });
  const params = new URLSearchParams(query || '');
  document.querySelectorAll('nav > a').forEach(a => {
    const r = a.dataset.r;
    a.classList.toggle('activo', r === partes[0] || (partes[0] === 'hoja-ruta' && r === 'salidas'));
  });
  document.getElementById('menu').classList.remove('abierto');
  document.getElementById('menuBtn').setAttribute('aria-expanded', 'false');
  window.scrollTo(0, 0);

  if (PRIVADAS.includes(partes[0]) && !SESION) {
    toast('aviso', 'Necesita iniciar sesión', 'Esta sección es solo para personal autorizado.');
    location.replace('#/login?volver=' + encodeURIComponent(h));
    return;
  }
  try {
    switch (partes[0]) {
      case '': await vistaPanel(); break;
      case 'login': await vistaLogin(params); break;
      case 'entradas': await vistaEntradas(params); break;
      case 'ventas': await vistaVentas(params); break;
      case 'salidas': await vistaSalidas(params); break;
      case 'hoja-ruta': await vistaHojaRuta(partes[1] || ''); break;
      case 'verificar': await vistaVerificar(partes[1] || ''); break;
      case 'reportes': await vistaReportes(); break;
      case 'usuarios': await vistaUsuarios(); break;
      case 'cuenta': await vistaCuenta(); break;
      default: $app.innerHTML = '<div class="vista"><h1>Página no encontrada</h1><p><a href="#/">Volver al panel</a></p></div>';
    }
  } catch (e) {
    $app.innerHTML = '<div class="mensaje error"><strong>Error:</strong> ' + esc((e && e.errores) ? e.errores.join(' ') : String(e)) +
      ' <button class="btn mini sec" onclick="enrutar()">Reintentar</button></div>';
  }
}

async function iniciar() {
  const btn = document.getElementById('menuBtn');
  btn.onclick = () => {
    const m = document.getElementById('menu');
    m.classList.toggle('abierto');
    btn.setAttribute('aria-expanded', m.classList.contains('abierto') ? 'true' : 'false');
  };
  try {
    const [cfg, ses] = await Promise.all([api('/api/config'), api('/api/sesion')]);
    CONFIG = cfg;
    SESION = ses.usuario;
  } catch (e) {
    $app.innerHTML = '<div class="mensaje error"><strong>No se pudo conectar con el servidor.</strong> Si el sitio estaba inactivo puede tardar hasta un minuto en despertar. ' +
      '<button class="btn mini sec" onclick="location.reload()">Reintentar</button></div>';
    return;
  }
  pintarUsuario();
  window.addEventListener('hashchange', enrutar);
  enrutar();
}
iniciar();
