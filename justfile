ort_version := "1.24.3"

setup:
    @echo "Checking ONNX Runtime Web {{ort_version}}..."
    @test -f lib/ort.min.js || just _fetch-ort
    @test -f lib/ort-wasm-simd-threaded.jsep.wasm || just _fetch-ort
    @echo "Checking centroid..."
    @test -f models/milady_centroid.json || (echo "Missing models/milady_centroid.json — run 'just all' to generate" && exit 1)
    @echo "Ready. Load this directory as an unpacked extension in chrome://extensions/"
    @echo "The ONNX encoder will be downloaded from Hugging Face on first run."

_fetch-ort:
    #!/usr/bin/env bash
    set -euo pipefail
    tmpdir=$(mktemp -d)
    echo "Fetching onnxruntime-web {{ort_version}}..."
    cd "$tmpdir" && npm pack onnxruntime-web@{{ort_version}} --silent && tar xzf onnxruntime-web-{{ort_version}}.tgz
    mkdir -p lib
    cp "$tmpdir/package/dist/ort.min.js" lib/
    cp "$tmpdir/package/dist/ort-wasm-simd-threaded.mjs" lib/
    cp "$tmpdir/package/dist/ort-wasm-simd-threaded.wasm" lib/
    cp "$tmpdir/package/dist/ort-wasm-simd-threaded.jsep.mjs" lib/
    cp "$tmpdir/package/dist/ort-wasm-simd-threaded.jsep.wasm" lib/
    rm -rf "$tmpdir"
    echo "ONNX Runtime Web installed to lib/"

package:
    rm -f cult-blocker.zip
    zip -r cult-blocker.zip \
        manifest.json \
        *.js *.html *.css \
        icons/ \
        lib/ \
        models/milady_centroid.json

download *args:
    uv run train.py download {{args}}

centroid *args:
    uv run train.py centroid {{args}}

all *args:
    uv run train.py all {{args}}
