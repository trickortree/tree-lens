# Tree Lens

A small Windows search bar, modelled on Google's Windows app: press **Alt+Space** (falls back to Ctrl+Shift+Space, then Ctrl+Alt+L, if another app has it) to get a floating bar.

- Type to find installed apps, or search the web.
- Click the **Lens** button, drag a box over anything on screen, and a small AI model (SmolVLM-256M) running on your PC describes, identifies or translates it. The model (~160 MB) downloads once on first use, then it works offline.
- Lives in the system tray (right-click for "Start with Windows" and Quit).

## Develop

```
npm install
npm start
```

## First-time GitHub setup

1. On github.com create an empty **public** repo `trickortree/tree-lens` (no README).
2. `npm run release -- 0.1.0` (commits everything, pushes, tags, and triggers the build).

After that, see `GUIDE.md` in the tree-app-store repo for editing and pushing.

## Not included (vs. Google's app)

Searching your files and Google Drive, and the online AI Mode. Everything here is local.
