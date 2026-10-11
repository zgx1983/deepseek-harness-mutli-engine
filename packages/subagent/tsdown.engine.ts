import { defineConfig, type UserConfig } from 'tsdown'

/** Build the legacy provider and main-engine entry without unpublished shared chunks. */
export default defineConfig(['index', 'startup'].map(entry => ({
  entry: [`lib/types/${entry}.js`], outDir: 'lib', format: ['esm'], platform: 'node', target: 'es2024',
  fixedExtension: false, outputOptions: { codeSplitting: false }, dts: false, clean: false,
} satisfies UserConfig)))
