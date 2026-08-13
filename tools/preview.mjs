#!/usr/bin/env node
/**
 * Genera capturas de la app sin tocar Firebase ni la base de producción.
 *
 *   node tools/preview.mjs            → captura generador + chafing en docs/
 *   node tools/preview.mjs generador  → solo una
 *
 * Cómo funciona y por qué:
 *  1. Copia index.html a un directorio temporal y le QUITA los 3 <script> de
 *     Firebase. Sin ellos, el try/catch de arranque deja FB_READY = false y la
 *     app entra en "Modo Demo". Esto es importante: loginSuccess() llama a
 *     logActivity('login'), que escribiría en la colección `actividad` REAL.
 *  2. Inyecta un auto-arranque que llama loginSuccess/navigate/doGenerate, para
 *     no necesitar credenciales. Ese script solo existe en la copia temporal.
 *  3. Sirve la copia y la fotografía con Chrome headless.
 *
 * Requisitos: Node 18+ y Google Chrome. Nada más.
 */
import { readFileSync, writeFileSync, copyFileSync, mkdirSync, rmSync, existsSync, statSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { join, dirname, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const RAIZ = dirname(dirname(fileURLToPath(import.meta.url)));
const DOCS = join(RAIZ, 'docs');
const TMP = join(tmpdir(), 'ayb-preview');
const PUERTO = 8777;

// Cada escena: qué se ejecuta al cargar y cómo de alta sale la captura.
const ESCENAS = {
  generador: {
    archivo: 'generador.html',
    salida: 'generador.png',
    alto: 2200,
    guion: `navigate('generador');
      genPersonas = 50; genDays = 5; genVegan = false;
      doGenerate();`,
  },
  chafing: {
    archivo: 'chafing.html',
    salida: 'chafing-dishes.png',
    alto: 2000,
    guion: `navigate('chafing');
      chafPersonas = 180;
      chafSelected = ['Pollo guisado','Costillas al horno','Albóndigas de res','Mangú de guineo verde',
                      'Yuca hervida','Platanitos fritos','Bistec encebollado','Arroz blanco','Ensalada César'];
      chafPrep = {};
      doChafingCalc();`,
  },
};

function chromePath() {
  const candidatos = [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    process.env.LOCALAPPDATA + '/Google/Chrome/Application/chrome.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
  ];
  const hit = candidatos.find(p => p && existsSync(p));
  if (!hit) throw new Error('No encontré Google Chrome. Instálalo o ajusta chromePath().');
  return hit;
}

function prepararCopia(nombres) {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(TMP, { recursive: true });

  let html = readFileSync(join(RAIZ, 'index.html'), 'utf8');
  const antes = (html.match(/firebasejs/g) || []).length;
  html = html.replace(/^\s*<script src="https:\/\/www\.gstatic\.com\/firebasejs\/[^"]*"><\/script>\s*$/gm, '');
  const despues = (html.match(/firebasejs/g) || []).length;
  if (despues !== 0) throw new Error(`Quedaron ${despues} scripts de Firebase: abortando para no tocar producción.`);
  console.log(`  Firebase: ${antes} scripts → 0 (modo demo, sin escrituras)`);

  copyFileSync(join(RAIZ, 'precios_rd.json'), join(TMP, 'precios_rd.json'));

  for (const n of nombres) {
    const e = ESCENAS[n];
    const boot = `
<script>
/* Auto-arranque SOLO para la captura. No existe en el index.html del repo. */
window.addEventListener('load', function () {
  setTimeout(function () {
    try {
      loginSuccess('Demo', 'demo@ayb.local');
      ${e.guion}
      console.log('BOOT_OK');
    } catch (err) { console.log('BOOT_ERR ' + err.message); }
  }, 400);
});
</` + `script>
`;
    writeFileSync(join(TMP, e.archivo), html.replace('</body>', boot + '</body>'));
  }
}

const TIPOS = { '.html': 'text/html; charset=utf-8', '.json': 'application/json; charset=utf-8' };

/** Servidor estático mínimo, atado a 127.0.0.1 y limitado al directorio temporal. */
function servidorEstatico(raiz, puerto) {
  const server = createServer((req, res) => {
    const rel = normalize(decodeURIComponent(req.url.split('?')[0])).replace(/^[/\\]+/, '');
    const abs = join(raiz, rel);
    // startsWith corta cualquier intento de salir de `raiz` con ../
    if (!abs.startsWith(raiz) || !existsSync(abs) || !statSync(abs).isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('no encontrado');
      return;
    }
    res.writeHead(200, { 'Content-Type': TIPOS[extname(abs)] || 'application/octet-stream' });
    res.end(readFileSync(abs));
  });
  return new Promise((ok, fallo) => {
    server.once('error', fallo);
    server.listen(puerto, '127.0.0.1', () => ok(server));
  });
}

/**
 * Lanza un proceso y espera SIN bloquear el event loop. Tiene que ser async:
 * el servidor de arriba vive en este mismo proceso, así que un spawnSync lo
 * dejaría sordo y Chrome nunca podría cargar la página.
 */
function correr(cmd, args, timeoutMs = 120000) {
  return new Promise(ok => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', d => { err += d; });
    const t = setTimeout(() => p.kill(), timeoutMs);
    p.on('error', e => { clearTimeout(t); ok({ code: -1, err: e.message }); });
    p.on('close', code => { clearTimeout(t); ok({ code, err }); });
  });
}

const pedidas = process.argv.slice(2).filter(a => ESCENAS[a]);
const nombres = pedidas.length ? pedidas : Object.keys(ESCENAS);

console.log('Preparando copia sin Firebase…');
prepararCopia(nombres);
mkdirSync(DOCS, { recursive: true });

const server = await servidorEstatico(TMP, PUERTO);

try {
  console.log(`Servidor en http://127.0.0.1:${PUERTO}\n`);

  for (const n of nombres) {
    const e = ESCENAS[n];
    const destino = join(DOCS, e.salida);
    const r = await correr(chromePath(), [
      '--headless=new', '--disable-gpu', '--hide-scrollbars',
      '--no-first-run', '--no-default-browser-check',
      '--disable-extensions', '--disable-background-networking',
      `--user-data-dir=${join(TMP, 'perfil')}`,
      `--window-size=1500,${e.alto}`,
      '--virtual-time-budget=8000',
      `--screenshot=${destino}`,
      `http://127.0.0.1:${PUERTO}/${e.archivo}`,
    ]);

    if (!existsSync(destino)) {
      console.error(`✗ ${n}: no se generó la captura\n${r.stderr || ''}`);
      process.exitCode = 1;
    } else {
      const kb = Math.round(readFileSync(destino).length / 1024);
      console.log(`✓ ${n.padEnd(10)} → docs/${e.salida} (${kb} KB)`);
    }
  }
} finally {
  server.close();
  // En Windows, Chrome deja el perfil bloqueado un instante tras salir; si no
  // se puede borrar no es un fallo: el temporal se limpia en la próxima corrida.
  try {
    rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  } catch {
    console.log(`\n(temporal no borrado, se reutiliza: ${TMP})`);
  }
}
