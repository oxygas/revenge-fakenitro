import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { resolve as pathResolve, dirname } from "path";
import { createHash } from "crypto";
import { rollup } from "rollup";
import esbuild from "rollup-plugin-esbuild";
import nodeResolve from "@rollup/plugin-node-resolve";
import commonjs from "@rollup/plugin-commonjs";

const PLUGIN_DIR = pathResolve(import.meta.dirname);
const DIST_DIR = pathResolve(PLUGIN_DIR, "dist", "fakenitro");
const MANIFEST = JSON.parse(readFileSync(pathResolve(PLUGIN_DIR, "manifest.json"), "utf-8"));

mkdirSync(DIST_DIR, { recursive: true });

// Build the plugin
const bundle = await rollup({
    input: pathResolve(PLUGIN_DIR, MANIFEST.main),
    plugins: [
        nodeResolve({
            browser: true,
        }),
        commonjs(),
        esbuild({
            target: "es2020",
            minify: true,
            jsx: "transform",
            jsxFactory: "React.createElement",
            jsxFragment: "React.Fragment",
        }),
        {
            name: "vendetta-externals",
            resolveId(id) {
                if (id.startsWith("@vendetta")) {
                    return { id, external: true };
                }
                return null;
            },
            renderDynamicImport({ format }) {
                return { left: "vendetta", right: "" };
            },
        },
        {
            name: "globals",
            renderChunk(code) {
                // Replace @vendetta imports with vendetta.* globals
                let transformed = code;

                // Map @vendetta imports to vendetta globals
                const importMap = {
                    "@vendetta": "vendetta",
                    "@vendetta/plugin": "vendetta.plugin",
                    "@vendetta/patcher": "vendetta.patcher",
                    "@vendetta/metro": "vendetta.metro",
                    "@vendetta/ui": "vendetta.ui",
                    "@vendetta/ui/components": "vendetta.ui.components",
                    "@vendetta/ui/alerts": "vendetta.ui.alerts",
                    "@vendetta/storage": "vendetta.storage",
                };

                // The bundler should have already resolved these, but we need
                // to ensure the output references the correct globals
                return { code: transformed, map: null };
            },
        },
    ],
    external: [
        "@vendetta",
        "@vendetta/plugin",
        "@vendetta/patcher",
        "@vendetta/metro",
        "@vendetta/ui",
        "@vendetta/ui/components",
        "@vendetta/ui/alerts",
        "@vendetta/storage",
    ],
    onwarn(warning, warn) {
        if (warning.code === "CIRCULAR_DEPENDENCY") return;
        warn(warning);
    },
});

const { output } = await bundle.generate({
    format: "iife",
    name: "FakeNitroPlugin",
    globals: {
        "@vendetta": "vendetta",
        "@vendetta/plugin": "vendetta.plugin",
        "@vendetta/patcher": "vendetta.patcher",
        "@vendetta/metro": "vendetta.metro",
        "@vendetta/ui": "vendetta.ui",
        "@vendetta/ui/components": "vendetta.ui.components",
        "@vendetta/ui/alerts": "vendetta.ui.alerts",
        "@vendetta/storage": "vendetta.storage",
    },
});

const chunk = output[0];
const code = chunk.code;

// Generate hash
const hash = createHash("sha256").update(code).digest("hex");

// Write the bundled code
writeFileSync(pathResolve(DIST_DIR, "index.js"), code);

// Write manifest with hash
const manifestWithHash = {
    ...MANIFEST,
    hash,
};
writeFileSync(pathResolve(DIST_DIR, "manifest.json"), JSON.stringify(manifestWithHash, null, 4));

console.log(`Built FakeNitro plugin to ${DIST_DIR}`);
console.log(`Hash: ${hash}`);
