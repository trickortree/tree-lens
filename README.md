# Tree Lens

A small Windows search bar modelled on Google's Windows app. Press **Alt+Space** (falls back to Ctrl+Shift+Space, then Ctrl+Alt+L, if another app has it).

- Type to find installed apps, or press Enter to ask the AI. Arrow keys pick an app or "Search Google" row instead.
- **+** attaches an image (or paste / drag one in). The **Lens** button lets you drag a box over your screen. Then press Describe / Identify / Translate, or type your own question about it.
- The globe button makes text questions search the web first (DuckDuckGo results are fed to the model, with source links shown).
- **Pin** (top right) or the tray menu: Keep on top, so the bar stays when you click away. Also "Start with Windows".
- Lives in the system tray.

## The AI

Runs on your PC through [Ollama](https://ollama.com) using `gemma3:4b` (a small Google model that can see images and translate). The first time you ask something, Tree Lens walks you through installing Ollama and downloading the model (about 3 GB, one time). Images stay on your PC; only the text of a question goes to a web search when the globe is on.

To use a different model change `MODEL` at the top of `ai.js` (for example `qwen2.5vl:3b`, or `gemma3:12b` if you have 16 GB RAM).

## Develop

```
npm install
npm start
```

## First-time GitHub setup

1. On github.com create an empty **public** repo `trickortree/tree-lens` (no README).
2. `npm run release -- 0.1.0` (commits everything, pushes, tags, and triggers the build).

See GUIDE.md for editing and pushing after that.

## Not included (vs. Google's app)

Searching your files and Drive, voice input and screen sharing.
