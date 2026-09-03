import * as esbuild from 'esbuild';
import { cp, mkdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';

const OUT = 'dist';
const watch = process.argv.includes('--watch');
const dev = watch || process.argv.includes('--dev');

const shared = {
  bundle: true,
  target: ['chrome116'],
  sourcemap: dev ? 'inline' : false,
  minify: !dev,
  drop: dev ? [] : ['console', 'debugger'],
  logLevel: 'info',
  jsx: 'automatic',
  jsxImportSource: 'preact',
  define: { 'process.env.NODE_ENV': dev ? '"development"' : '"production"' },
};

const targets = [
  { entry: 'src/background/index.ts', out: `${OUT}/background/index.js`, format: 'esm' },
  { entry: 'src/content/isolated.ts', out: `${OUT}/content/isolated.js`, format: 'iife' },
  { entry: 'src/content/main-world.ts', out: `${OUT}/content/main-world.js`, format: 'iife' },
  { entry: 'src/content/interceptor.ts', out: `${OUT}/content/interceptor.js`, format: 'iife' },
  { entry: 'src/ui/panel/main.tsx', out: `${OUT}/ui/panel.js`, format: 'iife' },
  { entry: 'src/ui/report/main.tsx', out: `${OUT}/ui/report.js`, format: 'iife' },
  { entry: 'src/ui/options/main.tsx', out: `${OUT}/ui/options.js`, format: 'iife' },
  {
    entry: 'src/ui/dashboard/main.tsx',
    outdir: `${OUT}/ui/dashboard`,
    format: 'esm',
    splitting: true,
    entryNames: 'dashboard',
    chunkNames: 'chunks/[name]-[hash]',
  },
];

async function copyStatic() {
  await mkdir(`${OUT}/ui`, { recursive: true });
  await mkdir(`${OUT}/ui/dashboard`, { recursive: true });
  await mkdir(`${OUT}/ui/shared`, { recursive: true });
  await mkdir(`${OUT}/shared`, { recursive: true });
  await mkdir(`${OUT}/content`, { recursive: true });
  await mkdir(`${OUT}/background`, { recursive: true });
  await mkdir(`${OUT}/icons`, { recursive: true });
  await mkdir(`${OUT}/logo`, { recursive: true });

  await cp('src/manifest.json', `${OUT}/manifest.json`);
  await cp('src/ui/panel/panel.html',     `${OUT}/ui/panel.html`);
  await cp('src/ui/report/report.html',   `${OUT}/ui/report.html`);
  await cp('src/ui/options/options.html', `${OUT}/ui/options.html`);
  await cp('src/ui/dashboard/dashboard.html', `${OUT}/ui/dashboard/dashboard.html`);
  await cp('src/ui/shared/styles.css',    `${OUT}/ui/styles.css`);
  await cp('src/ui/shared/theme.css',     `${OUT}/ui/shared/theme.css`);
  await cp('src/ui/shared/theme.css',     `${OUT}/shared/theme.css`);
  await cp('src/content/indicator.css', `${OUT}/content/indicator.css`);
  await cp('logo', `${OUT}/logo`, { recursive: true });

  // Generate simple placeholder icons if none exist
  for (const size of [16, 48, 128]) {
    const dest = `${OUT}/icons/icon${size}.png`;
    if (!existsSync(`src/icons/icon${size}.png`)) {
      // Write a minimal 1x1 transparent PNG as placeholder
      await writeFile(dest, Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
        'base64'
      ));
    } else {
      await cp(`src/icons/icon${size}.png`, dest);
    }
  }
}

async function run() {
  await rm(OUT, { recursive: true, force: true });
  await mkdir(OUT, { recursive: true });

  const contexts = [];
  for (const t of targets) {
    const outputDir = t.outdir ?? t.out.split('/').slice(0, -1).join('/');
    await mkdir(outputDir, { recursive: true });
    const opts = {
      ...shared,
      entryPoints: [t.entry],
      format: t.format,
      ...(t.out ? { outfile: t.out } : {}),
      ...(t.outdir ? { outdir: t.outdir } : {}),
      ...(t.splitting ? { splitting: t.splitting } : {}),
      ...(t.entryNames ? { entryNames: t.entryNames } : {}),
      ...(t.chunkNames ? { chunkNames: t.chunkNames } : {}),
    };
    if (watch) {
      const ctx = await esbuild.context(opts);
      await ctx.watch();
      contexts.push(ctx);
    } else {
      await esbuild.build(opts);
    }
  }

  await copyStatic();
  console.log(`\n[testtrace] ✓ ${dev ? 'dev' : 'prod'} build → ${OUT}/\n`);

  if (watch) {
    console.log('[testtrace] watching… (Ctrl+C to stop)');
    await new Promise(() => {});
  }
}

run().catch((err) => {
  console.error('[testtrace] build failed:', err.message ?? err);
  process.exit(1);
});
