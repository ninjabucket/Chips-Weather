# AGENTS.md

## Project identity

GNOME Shell extension **"Chips Weather"** — panel indicator showing current temperature + 8-hour forecast popup.
- UUID: `weather@chip`
- Target: GNOME Shell **50** (GJS 1.79+, Soup 3.0, ES modules)
- Repo: https://github.com/chip/chips-weather

## Architecture

Single-file extension (`extension.js`, ~530 lines) with one settings page (`prefs.js`). No build system, no dependencies, no tests.

**Entrypoints:**
- `extension.js` → `class WeatherExtension extends Extension` — `enable()` and `disable()`
- `prefs.js` → `class WeatherPreferences extends ExtensionPreferences` — `fillPreferencesWindow()`

**Data flow:**
1. `_getLocation()` → `ipapi.co/json/` (geolocate by IP)
2. `_fetchWeather(lat, lon)` → `api.open-meteo.com/v1/forecast` (48-hour hourly)
3. Panel updates label temperature + icon; menu rebuilds with 8-slot paginated forecast

**GSettings schema:** `org.gnome.shell.extensions.weather`
- `temperature-unit` (`"celsius"` / `"fahrenheit"`)
- `temperature-position` (`"left"` / `"right"` — icon vs label order in panel)

## Module system (GJS — non-negotiable)

GJS uses **ES modules** with non-standard import paths. Do NOT use npm packages, CommonJS `require()`, or Node.js APIs.

```js
// Correct:
import St from 'gi://St';
import Soup from 'gi://Soup?version=3.0';       // version qualifier required
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

// Wrong — these will fail at runtime:
import St from './st.js';                       // no such file
import {Extension} from '../extension.js';      // GI/resource imports only
const Soup = require('gi://Soup');             // no CommonJS
```

**Available `gi://` imports used in this project:** Clutter, GLib, Gtk, Soup (3.0), St, Adw

**Key gotcha:** Soup 2 vs Soup 3 are incompatible. This project uses `Soup?version=3.0` — the `?version=` qualifier is mandatory. API differences: `Soup.Session`, `Soup.Message.new_from_encoded_form()`, `send_and_read_async/send_and_read_finish`.

## Developing / testing

The extension **runs only inside GNOME Shell** — there is no unit-test or offline-test setup.

**Install for testing:**
```bash
# Copy to local extensions dir (directory name MUST match UUID)
cp -r . ~/.local/share/gnome-shell/extensions/weather@chip/
glib-compile-schemas ~/.local/share/gnome-shell/extensions/weather@chip/schemas/
# Restart shell: Alt+F2, type "r", Enter (X11) or logout/login (Wayland)
```

**Deploy to VM (the sync.sh workflow):**
```bash
./sync.sh   # rsyncs to chip@192.168.122.69, compiles schemas, restarts gdm
```

**Debug output:** `console.warn()` writes to journal. View with:
```bash
journalctl -f -o cat /usr/bin/gnome-shell | grep -i weather
```

**Looking Glass (GNOME Shell debugger):** Alt+F2 → type `lg` → Enter. Inspect extension state, run arbitrary GJS.

## Schema compilation

The `schemas/gschemas.compiled` is a **binary** that must match the target system's glib version. Always recompile after editing the XML or deploying to a different host:
```bash
glib-compile-schemas schemas/
```

The compiled file is tracked in the repo but should be regenerated per target.

## Packaging for extensions.gnome.org

The checked-in `chips-weather.zip` is the packaged extension. To repackage:
```bash
zip -r chips-weather.zip extension.js metadata.json prefs.js stylesheet.css schemas/
```

## Style conventions

- 4-space indentation, no semicolons at end of statements (project convention)
- Single quotes for strings
- Snake_case for private methods (`_updateWeather`), camelCase for variables
- `Clutter.EVENT_STOP` / `GLib.SOURCE_CONTINUE` / `GLib.SOURCE_REMOVE` in signal/timeout callbacks
- No trailing commas in objects/arrays (inconsistent in codebase — match surrounding style)

## Common pitfalls

1. **Don't add npm packages** — GJS has its own module system. The only dependencies are GI typelibs (`gi://`) and GNOME Shell resources (`resource:///`).
2. **Don't use `fetch()`** — use `Soup.Session` directly. The Promise wrapper pattern in `_fetchWeather` and `_getLocation` is the correct approach.
3. **GSettings keys are read with** `this._settings.get_string('key-name')` and written with `set_string()`. Key names are case-sensitive and must match the schema XML exactly.
4. **Cleanup in `disable()` is mandatory** — disconnect signals, abort HTTP session, remove GLib timeouts. GNOME Shell will hard-crash if references leak on disable/reload.
5. **Metadata version must match shell-version** — the array in `metadata.json` controls which GNOME Shell versions can load the extension. Version 50 = GNOME 50.
