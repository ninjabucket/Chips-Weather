# Chips Weather

GNOME Shell extension showing current weather in the panel with an hourly and daily forecast popup.

## Features

- **Panel indicator** — current temperature with weather icon
- **Hourly forecast** — 8-hour paginated view with temperature, UV index, and precipitation probability
- **Daily view** — 7-day forecast with high/low temperatures, weather icons, and precipitation
- **Color-coded temps** — blue-to-red gradient (optional)
- **Color-coded UV** — WHO scale labels (optional)
- **Mixed conditions** — dual icons when weather is split between two conditions
- **Auto-location** — IP-based geolocation via ipapi.co
- **Open-Meteo** — free weather API, no key required
- **Global** — US shows `City, ST`, everywhere else shows `City, Country`

## Compatibility

GNOME Shell 45, 46, 47, 48, 49, 50

## Installation

### From extensions.gnome.org

[![Get it on GNOME Extensions](https://raw.githubusercontent.com/mjakeman/extension-manager/main/data/icons/hicolor/scalable/apps/org.gnome.Extensions.svg)](https://extensions.gnome.org)

### Manual

```bash
git clone https://github.com/ninjabucket/Chips-Weather.git
cp -r Chips-Weather ~/.local/share/gnome-shell/extensions/weather@chip
glib-compile-schemas ~/.local/share/gnome-shell/extensions/weather@chip/schemas
```

Restart GNOME Shell (Alt+F2 → `r` on X11, logout/login on Wayland), then enable in Extensions.

## Preferences

- Temperature unit (Celsius / Fahrenheit)
- Temperature position (left / right of icon)
- Dynamic temperature color (on / off)
- Dynamic UV color (on / off)

## Data Sources

- Weather: [Open-Meteo](https://open-meteo.com)
- Location: [ipapi.co](https://ipapi.co)

## License

GPL-2.0-or-later
