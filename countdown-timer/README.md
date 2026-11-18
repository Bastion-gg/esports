# Bastion Countdown Timer

Run locally on the production LAN with Node.js 22+. On Windows, use Start_Timer.cmd or run node launcher.cjs. Open http://127.0.0.1:8780/ on the control machine. On display machines, open http://<LAN-IP>:8780/out/side (shared left/right, 800 by 1400) or /out/center (1920 by 1080). Use the same server for both outputs. Stop_Timer.cmd stops the server.

The server creates timer-state.json locally. Keep it off GitHub because it contains the control key. For matching typography, put the locally licensed Gotham-Black.otf and Display.ttf in public/assets. The app uses system fallbacks without local font files. Optional scene PNGs go in the sibling SPLIT_SCREENS directory or the directory configured by LED_SCENES_DIR.

GitHub stores source code. Run the live timer on the LAN server.
