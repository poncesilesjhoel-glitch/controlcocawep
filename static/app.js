/* Sistema de Control de Comercialización de la Hoja de Coca - interfaz (JavaScript puro) */
'use strict';

let CONFIG = null;
const $app = document.getElementById('app');

/* ------------------------------------------------------------------ utilidades */
// Formato boliviano: separador de miles "." y decimales ",": 1.250  /  4.000,00
function fmtNum(n, dec) {
  n = Number(n) || 0;
  const neg = n < 0;
  let s = Math.abs(n).toFixed(dec === undefined ? 2 : dec);
  let [ent, frac] = s.split('.');
  ent = ent.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return (neg ? '-' : '') + ent + (frac ? ',' + frac : '');
}
function fmtLb(n) {
  const d = Math.abs(n % 1) > 0.001 ? 1 : 0;
  return fmtNum(n, d) + ' lb';
}
const fmtBs = n => 'Bs ' + fmtNum(n, 2);
const fmtPct = n => fmtNum(n, 1) + ' %';
const fmtTq = n => fmtNum(n, Math.abs(n % 1) > 0.001 ? 1 : 0);
const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
function fmtFecha(iso) {
  if (!iso) return '';
  const [a, m, d] = iso.split('-');
  return d + '/' + m + '/' + a;
}
function fmtFechaLarga(iso) {
  const [a, m, d] = iso.split('-');
  return Number(d) + ' de ' + MESES[Number(m) - 1] + ' de ' + a;
}
const fmtMes = ym => { const [a, m] = ym.split('-'); return MESES[Number(m) - 1].replace(/^./, c => c.toUpperCase()) + ' ' + a; };
function esc(s) {
  return String(s === null || s === undefined ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function hoyISO() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
function qsString(obj) {
  const p = new URLSearchParams();
  Object.keys(obj).forEach(k => { if (obj[k] !== '' && obj[k] !== undefined && obj[k] !== null) p.set(k, obj[k]); });
  const s = p.toString();
  return s ? '?' + s : '';
}
function debounce(fn, ms) {
  let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}
function opciones(lista, sel, vacio) {
  return (vacio ? '<option value="">' + esc(vacio) + '</option>' : '') +
    lista.map(v => '<option' + (v === sel ? ' selected' : '') + '>' + esc(v) + '</option>').join('');
}

async function api(ruta, datos) {
  const opts = datos ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(datos) } : {};
  let r;
  try {
    r = await fetch(ruta, opts);
  } catch (e) {
    throw { errores: ['No se pudo conectar con el servidor. ¿Está ejecutándose app.py?'] };
  }
  let j = null;
  try { j = await r.json(); } catch (e) { /* sin cuerpo JSON */ }
  if (!r.ok) throw (j && j.errores) ? j : { errores: ['Error ' + r.status + ' del servidor.'] };
  return j;
}

function mostrarMensaje(el, tipo, titulo, lista) {
  el.innerHTML = '<div class="mensaje ' + tipo + '"><strong>' + esc(titulo) + '</strong>' +
    (lista && lista.length ? '<ul>' + lista.map(x => '<li>' + esc(x) + '</li>').join('') + '</ul>' : '') + '</div>';
}
function mostrarResultado(el, res) {
  el.innerHTML = '';
  const caja = document.createElement('div');
  el.appendChild(caja);
  mostrarMensaje(caja, 'ok', res.mensaje || 'Registrado correctamente.');
  if (res.avisos && res.avisos.length) {
    const c2 = document.createElement('div');
    el.appendChild(c2);
    mostrarMensaje(c2, 'aviso', 'Aviso', res.avisos);
  }
}
function datosForm(form) {
  const o = {};
  new FormData(form).forEach((v, k) => { o[k] = typeof v === 'string' ? v.trim() : v; });
  return o;
}
function selectorMercado(id, sel) {
  return '<select id="' + id + '"><option value="">Todos los mercados</option>' +
    Object.keys(CONFIG.mercados).map(m => '<option' + (m === sel ? ' selected' : '') + '>' + esc(m) + '</option>').join('') + '</select>';
}

/* ------------------------------------------------------------------ componentes gráficos */
function barrasDepartamentos(lista) {
  const max = Math.max(1, ...lista.map(d => d.libras));
  return '<div class="barras">' + lista.map(d =>
    '<div class="barra-fila"><span>' + esc(d.departamento) + '</span>' +
    '<div class="pista"><div class="relleno" style="width:' + (d.libras * 100 / max).toFixed(1) + '%"></div></div>' +
    '<span class="cifra"><strong>' + fmtLb(d.libras) + '</strong><small>' + fmtPct(d.porcentaje) + '</small></span></div>'
  ).join('') + '</div>';
}
function columnasPorDia(dias) {
  const max = Math.max(1, ...dias.map(d => d.libras));
  const cols = dias.map(d =>
    '<div class="col" data-tip="' + fmtFecha(d.fecha) + ': ' + fmtLb(d.libras) + ' (' + d.entradas + ' entradas)">' +
    '<div style="height:' + (d.libras * 100 / max).toFixed(1) + '%"></div></div>').join('');
  return '<div class="columnas">' + cols + '</div><div class="ejes"><span>' + fmtFecha(dias[0].fecha) +
    '</span><span>máx. ' + fmtLb(max) + '/día</span><span>' + fmtFecha(dias[dias.length - 1].fecha) + '</span></div>';
}
function bloqueInventario(inv) {
  const t = inv.total_en_mercado || 0;
  const p1 = t ? inv.sin_vender * 100 / t : 0;
  return '<div class="inv">' +
    '<div class="inv-item"><span>Sin vender (en puestos)</span><strong>' + fmtLb(inv.sin_vender) + '</strong></div>' +
    '<div class="inv-item"><span>Vendida, pendiente de salida</span><strong>' + fmtLb(inv.vendida_sin_salir) + '</strong></div>' +
    '<div class="inv-barra"><div style="width:' + p1.toFixed(1) + '%"></div><div style="width:' + (100 - p1).toFixed(1) + '%"></div></div>' +
    '<div class="leyenda"><span><i style="background:var(--verde)"></i>Sin vender</span><span><i style="background:var(--ocre)"></i>Vendida sin salir</span></div>' +
    '<div class="inv-total"><span>Total en mercado</span><span><strong>' + fmtLb(t) + '</strong> <small>≈ ' + fmtTq(inv.taques_equivalentes) + ' taques</small></span></div>' +
    '</div>';
}

/* ------------------------------------------------------------------ 1. Panel */
async function vistaPanel() {
  const mercado = sessionStorage.getItem('panelMercado') || '';
  $app.innerHTML = '<div class="encabezado"><div><h1>Panel general</h1><p class="sub">Movimiento de hoja de coca en los mercados autorizados</p></div>' +
    '<div class="filtros"><div><label for="fMercado">Mercado</label>' + selectorMercado('fMercado', mercado) + '</div></div></div>' +
    '<div id="panel"><p class="cargando">Cargando…</p></div>';
  document.getElementById('fMercado').onchange = e => { sessionStorage.setItem('panelMercado', e.target.value); vistaPanel(); };
  const r = await api('/api/resumen' + qsString({ mercado }));
  document.getElementById('panel').innerHTML =
    '<div class="kpis">' +
    kpi('Entradas registradas', fmtLb(r.entradas.libras), fmtNum(r.entradas.cantidad, 0) + ' ingresos · ' + fmtTq(r.entradas.taques) + ' taques') +
    kpi('Vendido', fmtLb(r.ventas.libras), fmtBs(r.ventas.monto) + ' · ' + fmtNum(r.ventas.cantidad, 0) + ' ventas') +
    kpi('Salidas a departamentos', fmtLb(r.salidas.libras), fmtNum(r.salidas.hojas_ruta, 0) + ' hojas de ruta emitidas') +
    kpi('Precio promedio', fmtBs(r.precio_promedio), 'por libra vendida', 'ocre') +
    kpi('Saldo en mercado', fmtLb(r.inventario.total_en_mercado), '≈ ' + fmtTq(r.inventario.taques_equivalentes) + ' taques', 'ocre') +
    '</div>' +
    '<div class="grid-2">' +
    '<div class="tarjeta"><h2>Coca enviada a cada departamento</h2>' + barrasDepartamentos(r.por_departamento) + '</div>' +
    '<div class="tarjeta"><h2>Inventario actual</h2>' + bloqueInventario(r.inventario) + '</div>' +
    '</div>' +
    '<div class="tarjeta"><h2>Entradas por día (últimos 30 días)</h2>' + columnasPorDia(r.por_dia) + '</div>';
}
function kpi(etq, val, det, cls) {
  return '<div class="tarjeta kpi ' + (cls || '') + '"><div class="etq">' + esc(etq) + '</div><div class="val">' + val + '</div><div class="det">' + det + '</div></div>';
}

/* ------------------------------------------------------------------ 2. Entradas */
async function vistaEntradas() {
  const mercados = Object.keys(CONFIG.mercados);
  $app.innerHTML =
    '<h1>Entradas al mercado</h1><p class="sub">Registro de la hoja de coca que ingresa a los mercados autorizados</p>' +
    '<div class="grid-form">' +
    '<form class="tarjeta" id="form" autocomplete="off" novalidate><h2>Nueva entrada</h2>' +
    '<label for="fecha">Fecha</label><input type="date" name="fecha" id="fecha" value="' + hoyISO() + '" max="' + hoyISO() + '">' +
    '<label for="mercado">Mercado</label><select name="mercado" id="mercado">' + opciones(mercados, mercados[0]) + '</select>' +
    '<label for="procedencia">Procedencia (provincia)</label><select name="procedencia" id="procedencia"></select>' +
    '<label for="productor">Productor</label><input name="productor" id="productor" placeholder="Nombre completo">' +
    '<label for="ci">CI del productor</label><input name="ci" id="ci" placeholder="Ej. 1234567 o 1234567-1A">' +
    '<div class="fila"><div><label for="taques">Taques</label><input type="number" name="taques" id="taques" min="0" step="0.5" value="1"></div>' +
    '<div><label for="libras">Libras <button type="button" class="link-btn" id="recalc" title="Volver a calcular">recalcular</button></label>' +
    '<input type="number" name="libras" id="libras" min="0" step="0.5" value="' + CONFIG.libras_por_taque + '"></div></div>' +
    '<div class="ayuda" id="ayudaPeso">1 taque = ' + CONFIG.libras_por_taque + ' lb (referencial). Las libras se calculan solas, pero puede corregirlas con el peso real.</div>' +
    '<label for="observacion">Observación</label><textarea name="observacion" id="observacion" placeholder="Opcional"></textarea>' +
    '<button class="btn ancho" type="submit">Registrar entrada</button>' +
    '<div id="msg"></div></form>' +
    '<div class="tarjeta"><div class="encabezado" style="margin:0"><h2 style="margin:0">Entradas registradas</h2>' +
    '<input id="buscar" placeholder="Buscar productor, CI, procedencia, Nº…" style="max-width:300px"></div>' +
    '<div class="tabla-box" id="tabla"><p class="vacio">Cargando…</p></div></div>' +
    '</div>';

  const f = document.getElementById('form');
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
      a.textContent = '1 taque = ' + CONFIG.libras_por_taque + ' lb (referencial). Esperado: ' + fmtLb(esp) + '.';
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
    const msg = document.getElementById('msg'), btn = f.querySelector('button[type=submit]');
    btn.disabled = true;
    try {
      const res = await api('/api/entradas', datosForm(f));
      mostrarResultado(msg, res);
      msg.insertAdjacentHTML('beforeend', '<p class="ayuda"><a href="#/ventas?entrada=' + res.id + '">Registrar una venta de esta entrada →</a></p>');
      f.productor.value = ''; f.ci.value = ''; f.observacion.value = ''; f.taques.value = 1; recalcular();
      cargar();
    } catch (e) {
      mostrarMensaje(msg, 'error', 'No se pudo registrar:', e.errores);
    } finally { btn.disabled = false; }
  };

  const buscar = document.getElementById('buscar');
  async function cargar() {
    const filas = await api('/api/entradas' + qsString({ q: buscar.value.trim() }));
    document.getElementById('tabla').innerHTML = filas.length ?
      '<table><thead><tr><th>Nº</th><th>Fecha</th><th>Mercado</th><th>Productor</th><th>CI</th><th>Procedencia</th>' +
      '<th class="num">Taques</th><th class="num">Libras</th><th class="num">Sin vender</th><th></th></tr></thead><tbody>' +
      filas.map(e => '<tr><td>' + e.id + '</td><td>' + fmtFecha(e.fecha) + '</td><td>' + esc(e.mercado.split(' (')[0]) + '</td>' +
        '<td>' + esc(e.productor) + (e.observacion ? ' <span title="' + esc(e.observacion) + '">📝</span>' : '') + '</td><td>' + esc(e.ci) + '</td>' +
        '<td>' + esc(e.procedencia) + '</td><td class="num">' + fmtTq(e.taques) + '</td><td class="num">' + fmtLb(e.libras) + '</td>' +
        '<td class="num"><span class="chip ' + (e.saldo > 0 ? '' : 'cero') + '">' + fmtLb(e.saldo) + '</span></td>' +
        '<td>' + (e.saldo > 0 ? '<a class="btn mini sec" href="#/ventas?entrada=' + e.id + '">Vender</a>' : '') + '</td></tr>').join('') +
      '</tbody></table>' : '<p class="vacio">No hay entradas que coincidan con la búsqueda.</p>';
  }
  buscar.oninput = debounce(cargar, 250);
  cargar();
}

/* ------------------------------------------------------------------ 3. Ventas */
async function vistaVentas(params) {
  $app.innerHTML =
    '<h1>Ventas</h1><p class="sub">Venta de hoja de coca a comerciantes detallistas, a partir de una entrada con saldo</p>' +
    '<div class="grid-form">' +
    '<form class="tarjeta" id="form" autocomplete="off" novalidate><h2>Nueva venta</h2>' +
    '<label for="fecha">Fecha</label><input type="date" name="fecha" id="fecha" value="' + hoyISO() + '" max="' + hoyISO() + '">' +
    '<label for="entrada_id">Entrada (lote) con saldo</label><select name="entrada_id" id="entrada_id"><option value="">Cargando…</option></select>' +
    '<div class="ayuda" id="saldoInfo"></div>' +
    '<label for="comprador">Comprador</label><input name="comprador" id="comprador" placeholder="Nombre completo">' +
    '<label for="ci_comprador">CI del comprador</label><input name="ci_comprador" id="ci_comprador" placeholder="Ej. 4567890">' +
    '<div class="fila"><div><label for="libras">Libras <button type="button" class="link-btn" id="todo">todo el saldo</button></label>' +
    '<input type="number" name="libras" id="libras" min="0" step="0.5"></div>' +
    '<div><label for="precio_libra">Precio por libra (Bs)</label><input type="number" name="precio_libra" id="precio_libra" min="0" step="0.5" value="40"></div></div>' +
    '<div class="total-vivo"><span>Total a pagar</span><strong id="total">Bs 0,00</strong></div>' +
    '<button class="btn ancho" type="submit">Registrar venta</button>' +
    '<div id="msg"></div></form>' +
    '<div class="tarjeta"><div class="encabezado" style="margin:0"><h2 style="margin:0">Ventas registradas</h2>' +
    '<input id="buscar" placeholder="Buscar comprador, CI, productor, Nº…" style="max-width:300px"></div>' +
    '<div class="tabla-box" id="tabla"><p class="vacio">Cargando…</p></div></div>' +
    '</div>';

  const f = document.getElementById('form');
  let entradas = [];
  const sel = f.entrada_id, info = document.getElementById('saldoInfo');
  const actual = () => entradas.find(e => String(e.id) === sel.value);
  const actualizarTotal = () => {
    const t = (parseFloat(f.libras.value) || 0) * (parseFloat(f.precio_libra.value) || 0);
    document.getElementById('total').textContent = fmtBs(t);
    const e = actual(), l = parseFloat(f.libras.value) || 0;
    if (e) {
      if (l > e.saldo) { info.className = 'ayuda alerta'; info.textContent = '⚠ La cantidad supera el saldo: quedan ' + fmtLb(e.saldo) + ' sin vender.'; }
      else { info.className = 'ayuda'; info.innerHTML = 'Quedan <strong>' + fmtLb(e.saldo) + '</strong> sin vender · ' + esc(e.procedencia) + ' · ' + esc(e.mercado); }
    } else { info.className = 'ayuda'; info.textContent = ''; }
  };
  async function cargarEntradas(preferida) {
    entradas = await api('/api/entradas?con_saldo=1');
    sel.innerHTML = '<option value="">— Elija una entrada —</option>' + entradas.map(e =>
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
    const msg = document.getElementById('msg'), btn = f.querySelector('button[type=submit]');
    btn.disabled = true;
    try {
      const res = await api('/api/ventas', datosForm(f));
      mostrarResultado(msg, res);
      msg.insertAdjacentHTML('beforeend', '<p class="ayuda"><a href="#/salidas?venta=' + res.id + '">Despachar esta venta a un departamento →</a></p>');
      f.comprador.value = ''; f.ci_comprador.value = ''; f.libras.value = '';
      await cargarEntradas(sel.value);
      cargar();
    } catch (e) {
      mostrarMensaje(msg, 'error', 'No se pudo registrar:', e.errores);
    } finally { btn.disabled = false; }
  };

  const buscar = document.getElementById('buscar');
  async function cargar() {
    const filas = await api('/api/ventas' + qsString({ q: buscar.value.trim() }));
    document.getElementById('tabla').innerHTML = filas.length ?
      '<table><thead><tr><th>Nº</th><th>Fecha</th><th>Entrada</th><th>Comprador</th><th>CI</th><th class="num">Libras</th>' +
      '<th class="num">Precio/lb</th><th class="num">Total</th><th class="num">Sin despachar</th><th></th></tr></thead><tbody>' +
      filas.map(v => '<tr><td>' + v.id + '</td><td>' + fmtFecha(v.fecha) + '</td><td title="' + esc(v.productor + ' · ' + v.procedencia) + '">Nº ' + v.entrada_id + '</td>' +
        '<td>' + esc(v.comprador) + '</td><td>' + esc(v.ci_comprador) + '</td><td class="num">' + fmtLb(v.libras) + '</td>' +
        '<td class="num">' + fmtBs(v.precio_libra) + '</td><td class="num">' + fmtBs(v.total) + '</td>' +
        '<td class="num"><span class="chip ' + (v.saldo > 0 ? 'ocre' : 'cero') + '">' + fmtLb(v.saldo) + '</span></td>' +
        '<td>' + (v.saldo > 0 ? '<a class="btn mini sec" href="#/salidas?venta=' + v.id + '">Despachar</a>' : '') + '</td></tr>').join('') +
      '</tbody></table>' : '<p class="vacio">No hay ventas que coincidan con la búsqueda.</p>';
  }
  buscar.oninput = debounce(cargar, 250);
  await cargarEntradas(params.get('entrada'));
  cargar();
}

/* ------------------------------------------------------------------ 4. Salidas */
async function vistaSalidas(params) {
  $app.innerHTML =
    '<h1>Salidas a departamentos</h1><p class="sub">Despacho de la coca vendida hacia cada departamento, con hoja de ruta</p>' +
    '<div class="grid-form">' +
    '<form class="tarjeta" id="form" autocomplete="off" novalidate><h2>Nueva salida</h2>' +
    '<label for="fecha">Fecha</label><input type="date" name="fecha" id="fecha" value="' + hoyISO() + '" max="' + hoyISO() + '">' +
    '<label for="venta_id">Venta con saldo por despachar</label><select name="venta_id" id="venta_id"><option value="">Cargando…</option></select>' +
    '<div class="ayuda" id="saldoInfo"></div>' +
    '<label for="departamento">Departamento destino</label><select name="departamento" id="departamento">' + opciones(CONFIG.departamentos, null, '— Elija el destino —') + '</select>' +
    '<div class="fila"><div><label for="libras">Libras <button type="button" class="link-btn" id="todo">todo</button></label>' +
    '<input type="number" name="libras" id="libras" min="0" step="0.5"></div>' +
    '<div><label for="placa">Placa del vehículo</label><input name="placa" id="placa" placeholder="Ej. 2345-KTR" style="text-transform:uppercase"></div></div>' +
    '<button class="btn ancho" type="submit">Registrar salida y emitir hoja de ruta</button>' +
    '<div id="msg"></div></form>' +
    '<div class="tarjeta"><div class="encabezado" style="margin:0"><h2 style="margin:0">Salidas registradas</h2>' +
    '<select id="fDepto" style="max-width:240px">' + opciones(CONFIG.departamentos, null, 'Todos los departamentos') + '</select></div>' +
    '<div class="tabla-box" id="tabla"><p class="vacio">Cargando…</p></div></div>' +
    '</div>';

  const f = document.getElementById('form');
  let ventas = [];
  const sel = f.venta_id, info = document.getElementById('saldoInfo');
  const actual = () => ventas.find(v => String(v.id) === sel.value);
  const actualizar = () => {
    const v = actual(), l = parseFloat(f.libras.value) || 0;
    if (!v) { info.textContent = ''; info.className = 'ayuda'; return; }
    if (l > v.saldo) { info.className = 'ayuda alerta'; info.textContent = '⚠ Supera lo pendiente: quedan ' + fmtLb(v.saldo) + ' por despachar.'; }
    else { info.className = 'ayuda'; info.innerHTML = 'Quedan <strong>' + fmtLb(v.saldo) + '</strong> por despachar · comprador ' + esc(v.comprador); }
  };
  ventas = await api('/api/ventas?con_saldo=1');
  sel.innerHTML = '<option value="">— Elija una venta —</option>' + ventas.map(v =>
    '<option value="' + v.id + '">Venta Nº ' + v.id + ' · ' + fmtFecha(v.fecha) + ' · ' + esc(v.comprador) + ' — quedan ' + fmtLb(v.saldo) + '</option>').join('');
  const pref = params.get('venta');
  if (pref && ventas.some(v => String(v.id) === pref)) { sel.value = pref; f.libras.value = actual().saldo; }
  sel.onchange = () => { const v = actual(); if (v) f.libras.value = v.saldo; actualizar(); };
  f.libras.oninput = actualizar;
  document.getElementById('todo').onclick = () => { const v = actual(); if (v) { f.libras.value = v.saldo; actualizar(); } };
  actualizar();

  f.onsubmit = async ev => {
    ev.preventDefault();
    const msg = document.getElementById('msg'), btn = f.querySelector('button[type=submit]');
    btn.disabled = true;
    try {
      const res = await api('/api/salidas', datosForm(f));
      location.hash = '#/hoja-ruta/' + encodeURIComponent(res.hoja_ruta);
    } catch (e) {
      mostrarMensaje(msg, 'error', 'No se pudo registrar:', e.errores);
      btn.disabled = false;
    }
  };

  const fDepto = document.getElementById('fDepto');
  async function cargar() {
    const filas = await api('/api/salidas' + qsString({ departamento: fDepto.value }));
    const tot = filas.reduce((s, x) => s + x.libras, 0);
    document.getElementById('tabla').innerHTML = filas.length ?
      '<table><thead><tr><th>Hoja de ruta</th><th>Fecha</th><th>Destino</th><th class="num">Libras</th><th>Placa</th><th>Comprador</th><th>Venta</th></tr></thead><tbody>' +
      filas.map(s => '<tr><td><a class="codigo" href="#/hoja-ruta/' + esc(s.hoja_ruta) + '">' + esc(s.hoja_ruta) + '</a></td><td>' + fmtFecha(s.fecha) + '</td>' +
        '<td><strong>' + esc(s.departamento) + '</strong></td><td class="num">' + fmtLb(s.libras) + '</td><td>' + esc(s.placa) + '</td>' +
        '<td>' + esc(s.comprador) + '</td><td>Nº ' + s.venta_id + '</td></tr>').join('') +
      '</tbody><tfoot><tr><td colspan="3">' + filas.length + ' salidas' + (filas.length >= 500 ? ' (últimas 500)' : '') + '</td><td class="num">' + fmtLb(tot) + '</td><td colspan="3"></td></tr></tfoot></table>'
      : '<p class="vacio">No hay salidas para este departamento.</p>';
  }
  fDepto.onchange = cargar;
  cargar();
}

/* ------------------------------------------------------------------ 5. Hoja de ruta */
async function vistaHojaRuta(codigo) {
  $app.innerHTML = '<p class="cargando">Cargando hoja de ruta…</p>';
  let h;
  try {
    h = await api('/api/hoja-ruta/' + encodeURIComponent(codigo));
  } catch (e) {
    $app.innerHTML = '<div class="resultado invalida"><div class="sello"><span class="icono">✕</span>HOJA DE RUTA NO ENCONTRADA</div><p>' +
      esc((e.errores || [])[0]) + '</p><a class="btn sec" href="#/salidas">Volver a salidas</a></div>';
    return;
  }
  const urlVerif = location.origin + '/#/verificar/' + h.hoja_ruta;
  $app.innerHTML =
    '<div class="acciones no-print"><button class="btn" id="imprimir">🖨 Imprimir</button>' +
    '<a class="btn sec" href="#/verificar/' + esc(h.hoja_ruta) + '">Verificar</a><a class="btn sec" href="#/salidas">Nueva salida</a></div>' +
    '<article class="hoja">' +
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
    '<div class="firmas"><div>Responsable del mercado</div><div>Comprador</div><div>Control en ruta</div></div>' +
    '<div class="hoja-pie">Verifique la autenticidad escaneando el código QR o ingresando el código en ' + esc(urlVerif.replace(/\/#\/verificar\/.*/, '/#/verificar')) +
    '. Documento válido solo para el destino y la cantidad indicados.</div>' +
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
  $app.innerHTML =
    '<h1>Verificar hoja de ruta</h1><p class="sub">Para puestos de control: ingrese el código impreso o escanee el QR</p>' +
    '<form class="verif-form" id="form"><input id="codigo" placeholder="HR-' + new Date().getFullYear() + '-000001" value="' + esc(codigo || '') + '">' +
    '<button class="btn" type="submit">Verificar</button></form><div id="res"></div>';
  const f = document.getElementById('form'), inp = document.getElementById('codigo');
  f.onsubmit = ev => {
    ev.preventDefault();
    const c = inp.value.trim().toUpperCase();
    if (c) location.hash = '#/verificar/' + encodeURIComponent(c);
  };
  if (!codigo) { inp.focus(); return; }
  const res = document.getElementById('res');
  try {
    const h = await api('/api/hoja-ruta/' + encodeURIComponent(codigo));
    res.innerHTML = '<div class="resultado valida"><div class="sello"><span class="icono">✓</span>HOJA DE RUTA VÁLIDA</div>' +
      '<dl class="dl"><dt>Código</dt><dd class="codigo">' + esc(h.hoja_ruta) + '</dd><dt>Fecha de emisión</dt><dd>' + fmtFechaLarga(h.fecha) + '</dd>' +
      '<dt>Destino</dt><dd style="font-size:1.25rem">' + esc(h.departamento) + '</dd><dt>Cantidad</dt><dd style="font-size:1.25rem">' + fmtLb(h.libras) + '</dd>' +
      '<dt>Comprador</dt><dd>' + esc(h.comprador) + ' · CI ' + esc(h.ci_comprador) + '</dd><dt>Placa</dt><dd>' + esc(h.placa) + '</dd>' +
      '<dt>Origen</dt><dd>' + esc(h.mercado) + ' · procedencia ' + esc(h.procedencia) + '</dd></dl>' +
      '<p class="no-print"><a href="#/hoja-ruta/' + esc(h.hoja_ruta) + '">Ver documento completo →</a></p></div>';
  } catch (e) {
    res.innerHTML = '<div class="resultado invalida"><div class="sello"><span class="icono">✕</span>NO VÁLIDA</div>' +
      '<p>El código <strong class="codigo">' + esc(codigo) + '</strong> no corresponde a ninguna hoja de ruta emitida por el sistema.</p>' +
      '<p>Retenga la carga y comunique a la autoridad competente.</p></div>';
  }
}

/* ------------------------------------------------------------------ 7. Reportes */
async function vistaReportes() {
  let filtros;
  try { filtros = JSON.parse(sessionStorage.getItem('filtrosRep') || 'null'); } catch (e) { filtros = null; }
  if (!filtros) {
    const d = new Date(); d.setDate(d.getDate() - 59);
    filtros = { desde: d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'), hasta: hoyISO(), mercado: '' };
  }
  $app.innerHTML =
    '<h1>Reportes</h1><p class="sub">Movimiento por departamento, por mes y por procedencia</p>' +
    '<form class="tarjeta filtros" id="form" style="margin-bottom:18px">' +
    '<div><label for="desde">Desde</label><input type="date" id="desde" value="' + filtros.desde + '"></div>' +
    '<div><label for="hasta">Hasta</label><input type="date" id="hasta" value="' + filtros.hasta + '"></div>' +
    '<div style="min-width:220px"><label for="fMercado">Mercado</label>' + selectorMercado('fMercado', filtros.mercado) + '</div>' +
    '<button class="btn" type="submit">Aplicar</button>' +
    '<span style="flex:1"></span>' +
    '<a class="btn ocre" id="csvDep">⬇ CSV departamentos</a><a class="btn ocre" id="csvSal">⬇ CSV salidas</a>' +
    '</form><div id="rep"><p class="cargando">Cargando…</p></div>';

  const f = document.getElementById('form');
  f.onsubmit = ev => {
    ev.preventDefault();
    sessionStorage.setItem('filtrosRep', JSON.stringify({ desde: f.desde.value, hasta: f.hasta.value, mercado: document.getElementById('fMercado').value }));
    vistaReportes();
  };
  const q = qsString(filtros);
  document.getElementById('csvDep').href = '/api/exportar/departamentos.csv' + q;
  document.getElementById('csvSal').href = '/api/exportar/salidas.csv' + q;

  const r = await api('/api/resumen' + q);
  const totS = r.salidas.libras;
  const tot = { e: 0, v: 0, s: 0, m: 0, h: 0 };
  r.por_mes.forEach(m => { tot.e += m.entradas_lb; tot.v += m.ventas_lb; tot.s += m.salidas_lb; tot.m += m.monto; tot.h += m.hojas_ruta; });
  document.getElementById('rep').innerHTML =
    '<div class="kpis">' +
    kpi('Entradas', fmtLb(r.entradas.libras), fmtNum(r.entradas.cantidad, 0) + ' ingresos') +
    kpi('Ventas', fmtLb(r.ventas.libras), fmtBs(r.ventas.monto)) +
    kpi('Salidas', fmtLb(totS), fmtNum(r.salidas.hojas_ruta, 0) + ' hojas de ruta') +
    kpi('Precio promedio', fmtBs(r.precio_promedio), 'por libra', 'ocre') +
    '</div>' +
    '<div class="grid-iguales">' +
    '<div class="tarjeta"><h2>Salidas por departamento</h2><div class="tabla-box" style="margin-top:0"><table><thead><tr><th>Departamento</th><th class="num">Libras</th>' +
    '<th class="num">Taques eq.</th><th class="num">Hojas de ruta</th><th class="num">%</th></tr></thead><tbody>' +
    r.por_departamento.map(d => '<tr><td>' + esc(d.departamento) + '</td><td class="num">' + fmtLb(d.libras) + '</td><td class="num">' +
      fmtTq(d.libras / CONFIG.libras_por_taque) + '</td><td class="num">' + d.hojas_ruta + '</td><td class="num">' + fmtPct(d.porcentaje) + '</td></tr>').join('') +
    '</tbody><tfoot><tr><td>Total</td><td class="num">' + fmtLb(totS) + '</td><td class="num">' + fmtTq(totS / CONFIG.libras_por_taque) +
    '</td><td class="num">' + r.salidas.hojas_ruta + '</td><td class="num">' + (totS ? '100 %' : '0 %') + '</td></tr></tfoot></table></div></div>' +
    '<div class="tarjeta"><h2>Distribución por departamento</h2>' + barrasDepartamentos(r.por_departamento) + '</div>' +
    '</div>' +
    '<div class="tarjeta" style="margin-bottom:18px"><h2>Movimiento por mes</h2><div class="tabla-box" style="margin-top:0"><table><thead><tr><th>Mes</th>' +
    '<th class="num">Entradas</th><th class="num">Ventas</th><th class="num">Salidas</th><th class="num">Hojas de ruta</th><th class="num">Monto vendido</th></tr></thead><tbody>' +
    (r.por_mes.length ? r.por_mes.map(m => '<tr><td>' + fmtMes(m.mes) + '</td><td class="num">' + fmtLb(m.entradas_lb) + '</td><td class="num">' + fmtLb(m.ventas_lb) +
      '</td><td class="num">' + fmtLb(m.salidas_lb) + '</td><td class="num">' + m.hojas_ruta + '</td><td class="num">' + fmtBs(m.monto) + '</td></tr>').join('')
      : '<tr><td colspan="6" class="vacio">Sin movimientos en el período.</td></tr>') +
    '</tbody><tfoot><tr><td>Total</td><td class="num">' + fmtLb(tot.e) + '</td><td class="num">' + fmtLb(tot.v) + '</td><td class="num">' + fmtLb(tot.s) +
    '</td><td class="num">' + tot.h + '</td><td class="num">' + fmtBs(tot.m) + '</td></tr></tfoot></table></div></div>' +
    '<div class="tarjeta"><h2>Entradas por procedencia</h2><div class="tabla-box" style="margin-top:0"><table><thead><tr><th>Mercado</th><th>Procedencia</th>' +
    '<th class="num">Ingresos</th><th class="num">Taques</th><th class="num">Libras</th><th class="num">%</th></tr></thead><tbody>' +
    (r.por_procedencia.length ? r.por_procedencia.map(p => '<tr><td>' + esc(p.mercado) + '</td><td>' + esc(p.procedencia) + '</td><td class="num">' + p.entradas +
      '</td><td class="num">' + fmtTq(p.taques) + '</td><td class="num">' + fmtLb(p.libras) + '</td><td class="num">' + fmtPct(p.porcentaje) + '</td></tr>').join('')
      : '<tr><td colspan="6" class="vacio">Sin entradas en el período.</td></tr>') +
    '</tbody></table></div></div>';
}

/* ------------------------------------------------------------------ enrutador */
async function enrutar() {
  const h = location.hash.replace(/^#\/?/, '');
  const [ruta, query] = h.split('?');
  const partes = ruta.split('/').map(decodeURIComponent);
  const params = new URLSearchParams(query || '');
  document.querySelectorAll('nav a').forEach(a => {
    const r = a.dataset.r;
    a.classList.toggle('activo', r === partes[0] || (partes[0] === 'hoja-ruta' && r === 'salidas'));
  });
  document.getElementById('menu').classList.remove('abierto');
  window.scrollTo(0, 0);
  try {
    switch (partes[0]) {
      case '': await vistaPanel(); break;
      case 'entradas': await vistaEntradas(params); break;
      case 'ventas': await vistaVentas(params); break;
      case 'salidas': await vistaSalidas(params); break;
      case 'hoja-ruta': await vistaHojaRuta(partes[1] || ''); break;
      case 'verificar': await vistaVerificar(partes[1] || ''); break;
      case 'reportes': await vistaReportes(); break;
      default: $app.innerHTML = '<h1>Página no encontrada</h1><p><a href="#/">Volver al panel</a></p>';
    }
  } catch (e) {
    $app.innerHTML = '<div class="mensaje error"><strong>Error:</strong> ' + esc((e && e.errores) ? e.errores.join(' ') : String(e)) + '</div>';
  }
}

async function iniciar() {
  document.getElementById('menuBtn').onclick = () => document.getElementById('menu').classList.toggle('abierto');
  try {
    CONFIG = await api('/api/config');
  } catch (e) {
    $app.innerHTML = '<div class="mensaje error"><strong>No se pudo conectar con el servidor.</strong> Ejecute <code>python app.py</code> y abra http://localhost:8000</div>';
    return;
  }
  window.addEventListener('hashchange', enrutar);
  enrutar();
}
iniciar();
