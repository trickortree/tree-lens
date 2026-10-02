// Runs the Tree Lens vision model off the main thread.
// First use downloads the model into cacheDir; after that it runs fully offline.
const { parentPort, workerData } = require("worker_threads");
const fs = require("fs");
const path = require("path");

const MODEL_ID = "HuggingFaceTB/SmolVLM-256M-Instruct";
const { cacheDir } = workerData;

const PROMPTS = {
    describe: () => "Describe this image in detail.",
    identify: () => "What is the main subject of this image? Name it, then explain briefly what it is.",
    translate: lang => `Transcribe all the text in this image, then translate it to ${lang}.`
};

let tf = null;
let loaded = null;

function status(text) {
    parentPort.postMessage({ type: "status", text });
}

const MODEL_FILES = [
    "config.json",
    "generation_config.json",
    "preprocessor_config.json",
    "processor_config.json",
    "tokenizer.json",
    "tokenizer_config.json",
    "onnx/embed_tokens.onnx",
    "onnx/vision_encoder_quantized.onnx",
    "onnx/decoder_model_merged_quantized.onnx"
];

// Download via .part + rename so an interrupted download never leaves a truncated model file.
async function ensureModelFiles() {
    for (const file of MODEL_FILES) {
        const dest = path.join(cacheDir, MODEL_ID, file);
        if (fs.existsSync(dest)) continue;
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        const res = await fetch(`https://huggingface.co/${MODEL_ID}/resolve/main/${file}`);
        if (!res.ok) throw new Error(`Model download failed (${res.status}) for ${file}`);
        const total = Number(res.headers.get("content-length")) || 0;
        const out = fs.createWriteStream(dest + ".part");
        let done = 0;
        for await (const chunk of res.body) {
            if (!out.write(chunk)) await new Promise(r => out.once("drain", r));
            done += chunk.length;
            if (total > 1e6) {
                status(`Downloading model (first use only): ${path.basename(file)} ${Math.round(done / total * 100)}%`);
            }
        }
        await new Promise((resolve, reject) => out.end(err => (err ? reject(err) : resolve())));
        fs.renameSync(dest + ".part", dest);
    }
}

async function load() {
    if (loaded) return loaded;
    await ensureModelFiles();
    status("Loading model...");
    tf = await import("@huggingface/transformers");
    tf.env.allowRemoteModels = false;
    tf.env.localModelPath = cacheDir;
    const processor = await tf.AutoProcessor.from_pretrained(MODEL_ID);
    const model = await tf.AutoModelForVision2Seq.from_pretrained(MODEL_ID, {
        dtype: { embed_tokens: "fp32", vision_encoder: "q8", decoder_model_merged: "q8" },
        device: "cpu"
    });
    loaded = { processor, model };
    return loaded;
}

async function run({ mode, lang, image }) {
    const { processor, model } = await load();
    status("Thinking...");
    const raw = await tf.RawImage.fromBlob(new Blob([image], { type: "image/png" }));
    const messages = [{
        role: "user",
        content: [{ type: "image" }, { type: "text", text: PROMPTS[mode](lang) }]
    }];
    const prompt = processor.apply_chat_template(messages, { add_generation_prompt: true });
    const inputs = await processor(prompt, [raw], { do_image_splitting: false });
    const out = await model.generate({ ...inputs, max_new_tokens: 300 });
    const [text] = processor.batch_decode(
        out.slice(null, [inputs.input_ids.dims.at(-1), null]),
        { skip_special_tokens: true }
    );
    return text.trim();
}

parentPort.on("message", async msg => {
    try {
        parentPort.postMessage({ type: "result", text: await run(msg) });
    } catch (err) {
        parentPort.postMessage({ type: "error", message: String(err && err.message || err) });
    }
});
