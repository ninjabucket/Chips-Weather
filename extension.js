/*
 * Copyright (C) 2026  chip
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 2 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */

//  Architecture
//  ------------
//  Data flow: ipinfo.io (geolocate by IP) → open-meteo.com (48h hourly + 7d daily) → panel + popup.
//  GJS module system: uses gi:// imports (Soup 3.0 required) and resource:/// for GNOME Shell APIs.
//  No npm, no fetch(), no Node.js — Soup.Session with Promise wrappers for async HTTP.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';
import Soup from 'gi://Soup';
import St from 'gi://St';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

const WEATHER_API = 'https://api.open-meteo.com/v1/forecast';
const GEO_API = 'https://ipinfo.io/json';

// WMO weather codes → GNOME symbolic icon names.
// Full code table: https://www.nodc.noaa.gov/archive/arc0021/0002199/1.1/data/0-data/HTML/WMO-CODE/WMO4677.HTM
const DAY_ICON_MAP = {
    0: 'weather-clear-symbolic',
    1: 'weather-few-clouds-symbolic',
    2: 'weather-few-clouds-symbolic',
    3: 'weather-overcast-symbolic',
    45: 'weather-fog-symbolic',
    48: 'weather-fog-symbolic',
    51: 'weather-showers-scattered-symbolic',
    53: 'weather-showers-scattered-symbolic',
    55: 'weather-showers-scattered-symbolic',
    56: 'weather-snow-symbolic',
    57: 'weather-snow-symbolic',
    61: 'weather-showers-symbolic',
    63: 'weather-showers-symbolic',
    65: 'weather-showers-symbolic',
    66: 'weather-freezing-rain-symbolic',
    67: 'weather-freezing-rain-symbolic',
    71: 'weather-snow-symbolic',
    73: 'weather-snow-symbolic',
    75: 'weather-snow-symbolic',
    77: 'weather-snow-symbolic',
    80: 'weather-showers-scattered-symbolic',
    81: 'weather-showers-symbolic',
    82: 'weather-showers-symbolic',
    85: 'weather-snow-symbolic',
    86: 'weather-snow-symbolic',
    95: 'weather-storm-symbolic',
    96: 'weather-storm-symbolic',
    99: 'weather-storm-symbolic',
};

const STATE_ABBR = {
    'alabama': 'AL', 'alaska': 'AK', 'arizona': 'AZ', 'arkansas': 'AR',
    'california': 'CA', 'colorado': 'CO', 'connecticut': 'CT', 'delaware': 'DE',
    'florida': 'FL', 'georgia': 'GA', 'hawaii': 'HI', 'idaho': 'ID',
    'illinois': 'IL', 'indiana': 'IN', 'iowa': 'IA', 'kansas': 'KS',
    'kentucky': 'KY', 'louisiana': 'LA', 'maine': 'ME', 'maryland': 'MD',
    'massachusetts': 'MA', 'michigan': 'MI', 'minnesota': 'MN', 'mississippi': 'MS',
    'missouri': 'MO', 'montana': 'MT', 'nebraska': 'NE', 'nevada': 'NV',
    'new hampshire': 'NH', 'new jersey': 'NJ', 'new mexico': 'NM', 'new york': 'NY',
    'north carolina': 'NC', 'north dakota': 'ND', 'ohio': 'OH', 'oklahoma': 'OK',
    'oregon': 'OR', 'pennsylvania': 'PA', 'rhode island': 'RI', 'south carolina': 'SC',
    'south dakota': 'SD', 'tennessee': 'TN', 'texas': 'TX', 'utah': 'UT',
    'vermont': 'VT', 'virginia': 'VA', 'washington': 'WA', 'west virginia': 'WV',
    'wisconsin': 'WI', 'wyoming': 'WY',
    'district of columbia': 'DC',
};

// Night icons only exist for clear/few-clouds. All other codes fall through to DAY_ICON_MAP.
const NIGHT_ICON_MAP = {
    0: 'weather-clear-night-symbolic',
    1: 'weather-few-clouds-night-symbolic',
    2: 'weather-few-clouds-night-symbolic',
};

// Short condition labels for hourly rows
const WEATHER_SHORT = {
    0: 'Clear', 1: 'Few Clouds', 2: 'Partly Cloudy', 3: 'Overcast',
    45: 'Foggy', 48: 'Rime Fog',
    51: 'Drizzle', 53: 'Drizzle', 55: 'Drizzle',
    56: 'Freezing Drizzle', 57: 'Freezing Drizzle',
    61: 'Rain', 63: 'Rain', 65: 'Heavy Rain',
    66: 'Freezing Rain', 67: 'Freezing Rain',
    71: 'Snow', 73: 'Snow', 75: 'Heavy Snow', 77: 'Snow Grains',
    80: 'Showers', 81: 'Showers', 82: 'Heavy Showers',
    85: 'Snow Showers', 86: 'Snow Showers',
    95: 'Storm', 96: 'Hail Storm', 99: 'Hail Storm',
};

const WIND_DIRS = ['N','NNE','NE','ENE','E','ESE','SE','SSE','S','SSW','SW','WSW','W','WNW','NW','NNW'];

// Extension lifecycle: enable() creates everything, disable() must destroy/disconnect all.
// GNOME Shell will hard-crash on reload if any references leak past disable().
export default class WeatherExtension extends Extension {
    enable() {
        this._http = null;
        this._timeoutId = 0;
        this._pulseTimeoutId = 0;
        this._fadeTimeoutId = 0;
        this._menuFadeInId = 0;
        this._rebuildFadeInId = 0;
        this._rebuildDelayId = 0;
        this._settings = null;
        this._allForecast = [];
        this._forecastPage = 0;
        this._location = '';
        this._bgContainer = null;
        this._viewMode = 'hourly';
        this._allDaily = [];
        this._activeDay = null;

        this._settings = this.getSettings();
        this._settings.connectObject(
            'changed::temperature-unit', () => { this._updateWeather(); },
            'changed::temperature-position', () => { this._applyPosition(); },
            'changed::use-colored-temps', () => { this._rebuildMenu(); },
            'changed::use-colored-uv', () => { this._rebuildMenu(); },
            'changed::show-uv-index', () => { this._rebuildMenu(); },
            'changed::show-precipitation', () => { this._rebuildMenu(); },
            this,
        );

        this._indicator = new PanelMenu.Button(0.5, this.metadata.name, false);
        this._indicator.menu.connectObject('open-state-changed', (menu, open) => {
            if (!open) this._hideTooltip();
            if (open && this._bgContainer) {
                this._bgContainer.opacity = 0;
                let step = 0;
                this._menuFadeInId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 15, () => {
                    step++;
                    if (this._bgContainer && step <= 8) {
                        this._bgContainer.opacity = Math.round((step / 8) * 255);
                        return GLib.SOURCE_CONTINUE;
                    }
                    this._menuFadeInId = 0;
                    return GLib.SOURCE_REMOVE;
                });
            }
        }, this);

        this._box = new St.BoxLayout({style_class: 'panel-status-menu-box'});
        this._icon = new St.Icon({
            icon_name: 'weather-clear-symbolic',
            style_class: 'system-status-icon',
        });
        this._label = new St.Label({
            text: '--°',
            y_align: Clutter.ActorAlign.CENTER,
            style: 'padding: 0 4px; font-weight: bold; font-size: 11px;',
        });
        this._applyPosition();
        this._indicator.add_child(this._box);

        Main.panel.addToStatusArea(this.uuid, this._indicator);

        this._http = new Soup.Session({user_agent: 'weather-extension/1.0'});
        this._updateWeather();

        this._timeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 600, () => {
            this._updateWeather();
            return GLib.SOURCE_CONTINUE;
        });
    }

    _iconName(code, isDay) {
        if (!isDay && NIGHT_ICON_MAP[code] !== undefined)
            return NIGHT_ICON_MAP[code];
        return DAY_ICON_MAP[code] || 'weather-clear-symbolic';
    }

    _pulseIcon() {
        const cycles = 3;
        const intervalMs = 17;
        const stepsPerCycle = 60;
        const halfCycle = stepsPerCycle / 2;
        const totalSteps = cycles * stepsPerCycle;
        let step = 0;
        this._pulseTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, intervalMs, () => {
            if (!this._icon) {
                this._pulseTimeoutId = 0;
                return GLib.SOURCE_REMOVE;
            }
            const pos = step % stepsPerCycle;
            step++;
            if (pos < halfCycle) {
                const t = pos / halfCycle;
                this._icon.opacity = Math.round(255 - (t * 175));
            } else {
                const t = (pos - halfCycle) / halfCycle;
                this._icon.opacity = Math.round(80 + (t * 175));
            }
            if (step >= totalSteps)
                this._pulseTimeoutId = 0;
            return step < totalSteps ? GLib.SOURCE_CONTINUE : GLib.SOURCE_REMOVE;
        });
    }

    _addHeader(subtitle) {
        if (!this._location) return;
        const locItem = new PopupMenu.PopupBaseMenuItem({reactive: false});
        const locLabel = new St.Label({
            text: this._location,
            style: 'font-size: 18px; font-weight: bold; color: #fff; padding: 4px 0 0 0;',
            x_align: Clutter.ActorAlign.CENTER,
            x_expand: true,
        });
        locItem.add_child(locLabel);
        this._indicator.menu.addMenuItem(locItem);

        const subItem = new PopupMenu.PopupBaseMenuItem({reactive: false});
        const subLabel = new St.Label({
            text: subtitle,
            style: 'font-size: 10px; color: #bbb; padding: 0 0 4px 0;',
            x_align: Clutter.ActorAlign.CENTER,
            x_expand: true,
        });
        subItem.add_child(subLabel);
        this._indicator.menu.addMenuItem(subItem);
    }

    _formatTime(isoStr) {
        if (!isoStr) return '';
        const d = new Date(isoStr);
        return d.toLocaleString('en-US', {hour: 'numeric', minute: '2-digit', hour12: true});
    }

    _weatherDesc(code) {
        return WEATHER_SHORT[code] || 'Unknown';
    }

    _windDir(deg) {
        const i = Math.round(deg / 22.5) % 16;
        return WIND_DIRS[i];
    }

    _windLabel(speed) {
        if (speed < 5) return 'Calm';
        if (speed < 20) return 'Light';
        if (speed < 40) return 'Breezy';
        if (speed < 60) return 'Windy';
        if (speed < 80) return 'Strong';
        return 'Gusty';
    }

    _daySummary(day, unit, isF) {
        const desc = this._weatherDesc(day.code).toLowerCase();
        let s = desc.charAt(0).toUpperCase() + desc.slice(1);
        if (day.precip > 20)
            s += `. ${day.precip}% chance of rain`;
        else if (day.precip > 0)
            s += ` with a ${day.precip}% chance of rain`;
        if (day.windMax > 20) {
            const dir = this._windDir(day.windDir);
            const windSpeed = isF ? Math.round(day.windMax * 0.621371) : day.windMax;
            const unit = isF ? 'mph' : 'km/h';
            s += `. ${this._windLabel(day.windMax)} winds ${dir} ${windSpeed} ${unit}`;
        }
        s += `. High ${day.high}${unit}, low ${day.low}${unit}`;
        return s;
    }

    _hideTooltip() {
        if (this._tooltip) {
            Main.uiGroup.remove_child(this._tooltip);
            this._tooltip.destroy();
            this._tooltip = null;
        }
    }

    _showTooltip(row, day, unit, isF) {
        this._hideTooltip();
        const todayName = new Date().toLocaleString('en-US', {weekday: 'long'});
        const shorts = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
        const weekdays = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
        const idx = shorts.indexOf(day.label);
        const targetDay = day.label === 'Today' ? todayName :
            idx >= 0 ? weekdays[idx] : todayName;
        const hours = this._allForecast.filter(f => f.day === targetDay);

        const periodStats = (ph) => {
            if (!ph || ph.length === 0) return null;
            const avgTemp = Math.round(ph.reduce((s, h) => s + h.temp, 0) / ph.length);
            const maxPrecip = Math.max(...ph.map(h => h.precip));
            const codes = {};
            for (const h of ph) codes[h.iconCode] = (codes[h.iconCode] || 0) + 1;
            const dominant = parseInt(Object.entries(codes).sort((a, b) => b[1] - a[1])[0][0]);
            return {temp: avgTemp, precip: maxPrecip, code: dominant, isDay: ph[0].isDay};
        };

        const avgFeels = hours.length > 0 ? Math.round(hours.reduce((s, h) => s + h.feels, 0) / hours.length) : null;
        const avgHumidity = hours.length > 0 ? Math.round(hours.reduce((s, h) => s + h.humidity, 0) / hours.length) : null;
        const maxWind = hours.length > 0 ? Math.max(...hours.map(h => h.wind)) : null;
        const maxUv = hours.length > 0 ? Math.max(...hours.map(h => h.uv)) : null;

        const uvLabel = (u) => {
            if (u <= 2) return 'Low';
            if (u <= 5) return 'Moderate';
            if (u <= 7) return 'High';
            if (u <= 10) return 'Very High';
            return 'Extreme';
        };

        const morning = hours.filter(f => f.hour >= 6 && f.hour < 12);
        const afternoon = hours.filter(f => f.hour >= 12 && f.hour < 18);
        const evening = hours.filter(f => f.hour >= 18 && f.hour < 21);
        const night = hours.filter(f => f.hour >= 21 || f.hour < 6);

        const box = new St.BoxLayout({
            vertical: true,
            style: 'padding: 10px 12px; border-radius: 8px; background-color: rgba(30, 30, 30, 0.95); border: 1px solid rgba(255,255,255,0.15); spacing: 3px; width: 220px;',
        });

        const cond = this._weatherDesc(day.code);
        const topRow = new St.BoxLayout({style: 'spacing: 8px; padding: 0 0 2px 0;'});
        topRow.add_child(new St.Icon({
            icon_name: this._iconName(day.code, true),
            style: 'icon-size: 28px; color: #eee;',
        }));
        topRow.add_child(new St.Label({
            text: cond,
            style: 'font-size: 14px; font-weight: bold; color: #fff;',
            y_align: Clutter.ActorAlign.CENTER,
        }));
        box.add_child(topRow);

        const summary = this._daySummary(day, unit, isF);
        const summaryLabel = new St.Label({
            text: summary,
            style: 'font-size: 11px; color: #bbb; padding: 0 0 6px 0;',
            x_expand: true,
        });
        summaryLabel.clutter_text.line_wrap = true;
        summaryLabel.clutter_text.line_wrap_mode = Pango.WrapMode.WORD;
        box.add_child(summaryLabel);

        const hiloRow = new St.BoxLayout({style: 'spacing: 12px; padding: 2px 0;'});
        hiloRow.add_child(new St.Label({text: `H: ${day.high}${unit}`, style: 'font-size: 12px; font-weight: bold; color: #eee;'}));
        hiloRow.add_child(new St.Label({text: `L: ${day.low}${unit}`, style: 'font-size: 12px; color: #999;'}));
        if (avgFeels !== null)
            hiloRow.add_child(new St.Label({text: `Feels ${avgFeels}${unit}`, style: 'font-size: 12px; color: #aaa;'}));
        box.add_child(hiloRow);

        box.add_child(new St.Label({text: ' ', style: 'font-size: 2px;'}));

        const detailRow = (label, value, color = '#aaa') => {
            const r = new St.BoxLayout({style: 'spacing: 4px;'});
            r.add_child(new St.Label({text: label, style: 'font-size: 11px; color: #777; min-width: 72px;'}));
            r.add_child(new St.Label({text: value, style: `font-size: 11px; color: ${color};`}));
            return r;
        };

        if (avgHumidity !== null)
            box.add_child(detailRow('Humidity', `${avgHumidity}%`));
        if (maxUv !== null && maxUv > 0) {
            const uvC = maxUv <= 2 ? '#8bc34a' : maxUv <= 5 ? '#ffc107' : maxUv <= 7 ? '#ff9800' : '#f44336';
            box.add_child(detailRow('UV Index', `${maxUv} ${uvLabel(maxUv)}`, uvC));
        }
        if (maxWind !== null) {
            const windSpeed = isF ? Math.round(maxWind * 0.621371) : maxWind;
            const windUnit = isF ? 'mph' : 'km/h';
            box.add_child(detailRow('Wind', `${windSpeed} ${windUnit}`));
        }
        box.add_child(detailRow('Precip', `${day.precip}%`, '#64b5f6'));
        if (day.sunrise) {
            const sr = this._formatTime(day.sunrise);
            const ss = this._formatTime(day.sunset);
            if (sr && ss)
                box.add_child(detailRow('Daylight', `${sr}–${ss}`, '#888'));
        }

        box.add_child(new St.Label({text: ' ', style: 'font-size: 4px;'}));

        const periods = [
            {label: 'Morning', stats: periodStats(morning)},
            {label: 'Afternoon', stats: periodStats(afternoon)},
            {label: 'Evening', stats: periodStats(evening)},
            {label: 'Night', stats: periodStats(night)},
        ];
        const validPeriods = periods.filter(p => p.stats);
        if (validPeriods.length > 0) {
            box.add_child(new St.Label({text: ' ', style: 'font-size: 2px;'}));
            for (const p of validPeriods) {
                const pr = new St.BoxLayout({style: 'spacing: 4px;'});
                pr.add_child(new St.Icon({
                    icon_name: this._iconName(p.stats.code, p.stats.isDay),
                    style: 'icon-size: 14px; min-width: 18px; color: #ccc;',
                    y_align: Clutter.ActorAlign.CENTER,
                }));
                pr.add_child(new St.Label({text: p.label, style: 'font-size: 11px; font-weight: bold; color: #ddd; min-width: 68px;'}));
                pr.add_child(new St.Label({text: `${p.stats.temp}${unit}`, style: 'font-size: 11px; color: #eee;'}));
                pr.add_child(new St.Label({text: `${p.stats.precip}%`, style: 'font-size: 10px; color: #64b5f6;'}));
                box.add_child(pr);
            }
        }

        Main.uiGroup.add_child(box);

        const [rowX, rowY] = row.get_transformed_position();
        const rowH = row.get_allocation_box().y2 - row.get_allocation_box().y1;
        const tipWidth = 210;
        const stageW = global.stage.width;
        const stageH = global.stage.height;

        const menuActor = this._indicator.menu.actor || this._indicator.menu;
        const [menuX, menuY] = menuActor.get_transformed_position();
        const menuW = menuActor.get_allocation_box().x2 - menuActor.get_allocation_box().x1;
        const menuRight = menuX + menuW;
        const menuLeft = menuX;

        let tipX;
        if (stageW - menuRight >= tipWidth + 8) {
            tipX = menuRight + 6;
        } else if (menuLeft >= tipWidth + 8) {
            tipX = menuLeft - tipWidth - 6;
        } else {
            tipX = Math.max(4, menuRight + 4);
        }

        const tipH = box.get_allocation_box().y2 - box.get_allocation_box().y1;
        const rowCenter = rowY + (rowH / 2);
        let tipY = rowCenter - (tipH / 2);
        tipY = Math.max(4, Math.min(tipY, stageH - tipH - 8));

        box.set_position(tipX, tipY);
        this._tooltip = box;
    }

    _fadeToPage() {
        if (this._bgContainer) {
            let fadeStep = 0;
            const totalFade = 6;
            this._fadeTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 15, () => {
                fadeStep++;
                if (this._bgContainer) {
                    this._bgContainer.opacity = Math.round(255 * (1 - fadeStep / totalFade));
                }
                if (fadeStep >= totalFade) {
                    this._fadeTimeoutId = 0;
                    this._rebuildMenu();
                    return GLib.SOURCE_REMOVE;
                }
                return GLib.SOURCE_CONTINUE;
            });
        } else {
            this._rebuildMenu();
        }
    }

    _applyPosition() {
        const pos = this._settings?.get_string('temperature-position') || 'right';
        if (this._icon && this._label) {
            while (this._box.get_first_child())
                this._box.remove_child(this._box.get_first_child());
            if (pos === 'left') {
                this._box.add_child(this._label);
                this._box.add_child(this._icon);
            } else {
                this._box.add_child(this._icon);
                this._box.add_child(this._label);
            }
        }
    }

    _rebuildMenu() {
        if (this._viewMode === 'daily') {
            this._rebuildDailyMenu();
            return;
        }
        const items = this._indicator.menu._getMenuItems();
        for (let i = items.length - 1; i >= 0; i--)
            items[i].destroy();

        let forecast = this._allForecast;
        if (this._activeDay)
            forecast = this._allForecast.filter(f => f.day === this._activeDay);

        const unit = (this._settings?.get_string('temperature-unit') === 'fahrenheit')
            ? '°F' : '°C';
        const showUv = this._settings?.get_boolean('show-uv-index') !== false;
        const showPrecip = this._settings?.get_boolean('show-precipitation') !== false;

        const tempColor = (t) => {
            const isF = unit === '°F';
            if (isF) {
                if (t < 32) return '#64b5f6';
                if (t < 50) return '#42a5f5';
                if (t < 65) return '#26a69a';
                if (t < 75) return '#66bb6a';
                if (t < 85) return '#ffca28';
                if (t < 95) return '#ffa726';
                return '#ef5350';
            }
            if (t < 0) return '#64b5f6';
            if (t < 10) return '#42a5f5';
            if (t < 18) return '#26a69a';
            if (t < 24) return '#66bb6a';
            if (t < 30) return '#ffca28';
            if (t < 35) return '#ffa726';
            return '#ef5350';
        };

        const uvStyle = (uv) => {
            if (uv <= 2) return {color: '#8bc34a', label: 'Low'};
            if (uv <= 5) return {color: '#ffc107', label: 'Mod'};
            if (uv <= 7) return {color: '#ff9800', label: 'High'};
            if (uv <= 10) return {color: '#f44336', label: 'V.High'};
            return {color: '#ce93d8', label: 'Extreme'};
        };

        if (this._location) {
            let subtitle = 'Hourly';
            if (forecast.length > 0) {
                const perPage = 8;
                const todayDay = this._allForecast[0]?.day || '';
                const headerItems = forecast.slice(
                    this._forecastPage * perPage, this._forecastPage * perPage + perPage,
                );
                const days = [...new Set(headerItems.map(f => f.day).filter(Boolean))];
                const labels = days.map(d => d === todayDay ? 'Today' : d);
                subtitle = labels.join(' & ') + ' — Hourly';
            }
            this._addHeader(subtitle);
        }

        if (this._allForecast.length > 0) {
            const perPage = 8;
            const maxPage = Math.ceil(forecast.length / perPage) - 1;
            const pageItems = forecast.slice(
                this._forecastPage * perPage, this._forecastPage * perPage + perPage,
            );

            const bgContainer = new St.BoxLayout({
                style_class: 'weather-bg-box',
                vertical: true,
                opacity: 0,
            });

            for (let i = 0; i < pageItems.length; i++) {
                const f = pageItems[i];
                const row = new St.BoxLayout({
                    x_expand: true,
                    style: 'padding: 3px 8px; spacing: 4px;',
                });
                if (i % 2 === 0)
                    row.style = 'padding: 3px 8px; spacing: 4px; background-color: rgba(255,255,255,0.04);';

                const timeLabel = new St.Label({
                    text: f.label,
                    style: 'font-size: 12px; font-weight: bold; min-width: 36px; color: #eee;',
                    y_align: Clutter.ActorAlign.CENTER,
                });
                row.add_child(timeLabel);

                const icon = new St.Icon({
                    icon_name: this._iconName(f.iconCode, f.isDay),
                    style: 'icon-size: 16px; min-width: 20px;',
                    y_align: Clutter.ActorAlign.CENTER,
                });
                row.add_child(icon);

                if (showPrecip) {
                    const precipTxt = `${f.precip}%`;
const precipColor = '#64b5f6';
                row.add_child(new St.Label({
                    text: `${f.precip}%`,
                    style: `font-size: 10px; color: ${precipColor}; min-width: 26px;`,
                        y_align: Clutter.ActorAlign.CENTER,
                    }));
                }

                if (showUv) {
                    if (f.isDay) {
                        const uv = uvStyle(f.uv);
                        row.add_child(new St.Label({
                            text: `UV ${f.uv}`,
                            style: `font-size: 10px; color: ${uv.color}; min-width: 30px;`,
                            y_align: Clutter.ActorAlign.CENTER,
                        }));
                    } else {
                        row.add_child(new St.Icon({
                            icon_name: 'weather-clear-night-symbolic',
                            style: 'icon-size: 12px; min-width: 30px; color: #aaa;',
                            y_align: Clutter.ActorAlign.CENTER,
                        }));
                    }
                }

                const cond = WEATHER_SHORT[f.iconCode] || '';
                if (cond) {
                    row.add_child(new St.Label({
                        text: cond,
                        style: 'font-size: 10px; color: #999; min-width: 60px;',
                        y_align: Clutter.ActorAlign.CENTER,
                    }));
                }

                row.add_child(new St.Bin({x_expand: true}));

                const tempLabel = new St.Label({
                    text: `${f.temp}°`,
                    style: `font-size: 12px; font-weight: bold; color: ${tempColor(f.temp)};`,
                    y_align: Clutter.ActorAlign.CENTER,
                });
                row.add_child(tempLabel);

                row.reactive = true;
                row.track_hover = true;
                row.connect('enter-event', () => { row.opacity = 180; });
                row.connect('leave-event', () => { row.opacity = 255; });

                const rowItem = new PopupMenu.PopupBaseMenuItem({reactive: false});
                rowItem.add_child(row);
                bgContainer.add_child(rowItem);
            }

            const navRow = new St.BoxLayout({
                x_expand: true,
                x_align: Clutter.ActorAlign.FILL,
                style: 'padding: 4px 6px 2px 6px;',
            });

            const refreshBtn = new St.Button({
                label: '↻',
                reactive: true,
                can_focus: true,
                track_hover: true,
                style_class: 'weather-nav-btn',
                x_align: Clutter.ActorAlign.START,
            });
            refreshBtn.connect('button-press-event', () => {
                this._activeDay = null;
                this._updateWeather();
                return Clutter.EVENT_STOP;
            });

            const centerBox = new St.BoxLayout({
                x_expand: true,
                x_align: Clutter.ActorAlign.CENTER,
                style: 'spacing: 16px;',
            });

            const prevBtn = new St.Button({
                label: '◀',
                reactive: true,
                can_focus: true,
                track_hover: true,
                style_class: 'weather-nav-btn',
            });
            prevBtn.connect('button-press-event', () => {
                if (this._forecastPage > 0) {
                    this._forecastPage--;
                    this._fadeToPage();
                }
                return Clutter.EVENT_STOP;
            });

            const pageLabel = new St.Label({
                text: `${this._forecastPage + 1}/${maxPage + 1}`,
                y_align: Clutter.ActorAlign.CENTER,
                style: 'font-size: 11px;',
            });

            const nextBtn = new St.Button({
                label: '▶',
                reactive: true,
                can_focus: true,
                track_hover: true,
                style_class: 'weather-nav-btn',
            });
            nextBtn.connect('button-press-event', () => {
                if (this._forecastPage < maxPage) {
                    this._forecastPage++;
                    this._fadeToPage();
                }
                return Clutter.EVENT_STOP;
            });

            const prefsBtn = new St.Button({
                label: '⚙',
                reactive: true,
                can_focus: true,
                track_hover: true,
                style_class: 'weather-nav-btn',
                x_align: Clutter.ActorAlign.END,
            });
            prefsBtn.connect('button-press-event', () => {
                this.openPreferences();
                return Clutter.EVENT_STOP;
            });

            centerBox.add_child(prevBtn);
            centerBox.add_child(pageLabel);
            centerBox.add_child(nextBtn);
            navRow.add_child(refreshBtn);
            navRow.add_child(centerBox);
            navRow.add_child(prefsBtn);

            const toggleRow = new St.BoxLayout({
                x_expand: true,
                x_align: Clutter.ActorAlign.CENTER,
                style: 'padding: 0px 6px 4px 6px;',
            });
            const toggleBtn = new St.Button({
                child: new St.Icon({
                    icon_name: 'x-office-calendar-symbolic',
                    style: 'icon-size: 14px;',
                }),
                reactive: true,
                can_focus: true,
                track_hover: true,
                style: 'padding: 2px 8px; border-radius: 4px;',
            });
            toggleBtn.connect('button-press-event', () => {
                this._activeDay = null;
                this._viewMode = 'daily';
                this._fadeToPage();
                return Clutter.EVENT_STOP;
            });
            toggleRow.add_child(toggleBtn);

            const bottomBox = new St.BoxLayout({vertical: true, x_expand: true});
            bottomBox.add_child(navRow);
            bottomBox.add_child(toggleRow);

            const navItem = new PopupMenu.PopupBaseMenuItem({reactive: false});
            navItem.add_child(bottomBox);
            bgContainer.add_child(new PopupMenu.PopupSeparatorMenuItem());
            bgContainer.add_child(navItem);

            this._bgContainer = bgContainer;
            const bgItem = new PopupMenu.PopupBaseMenuItem({reactive: false});
            bgItem.add_child(bgContainer);
            this._indicator.menu.addMenuItem(bgItem);

            if (this._rebuildDelayId > 0) {
                GLib.Source.remove(this._rebuildDelayId);
                this._rebuildDelayId = 0;
            }
            this._rebuildDelayId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 10, () => {
                this._rebuildDelayId = 0;
                let fi = 0;
                const fiSteps = 6;
                if (this._rebuildFadeInId > 0) {
                    GLib.Source.remove(this._rebuildFadeInId);
                    this._rebuildFadeInId = 0;
                }
                this._rebuildFadeInId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 15, () => {
                    fi++;
                    if (this._bgContainer) {
                        this._bgContainer.opacity = Math.round(255 * (fi / fiSteps));
                    }
                    if (fi >= fiSteps)
                        this._rebuildFadeInId = 0;
                    return fi < fiSteps ? GLib.SOURCE_CONTINUE : GLib.SOURCE_REMOVE;
                });
                return GLib.SOURCE_REMOVE;
            });

            this._indicator.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        }
    }

    async _updateWeather() {
        try {
            const loc = await this._getLocation();
            if (loc) {
                const isUS = loc.country === 'US';
                const region = isUS && loc.region
                    ? (STATE_ABBR[loc.region.toLowerCase()] || loc.region)
                    : '';
                const suffix = isUS
                    ? (region ? ', ' + region : '')
                    : (loc.country ? ', ' + loc.country : '');
                this._location = loc.city
                    ? `${loc.city}${suffix}`
                    : '';
                await this._fetchWeather(loc.lat, loc.lon);
            }
        } catch (e) {
            console.warn(`Weather: ${e}`);
        }
    }

    _getLocation() {
        const msg = Soup.Message.new('GET', GEO_API);
        msg.request_headers.append('Accept', 'application/json');

        return new Promise((resolve, reject) => {
            this._http.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, null,
                (_session, result) => {
                    try {
                        const bytes = this._http.send_and_read_finish(result);
                        const data = bytes?.get_data();
                        if (!data) { reject('No location data'); return; }
                        const json = JSON.parse(new TextDecoder().decode(data));
                        const [latStr, lonStr] = (json.loc || '').split(',');
                        const lat = parseFloat(latStr);
                        const lon = parseFloat(lonStr);
                        if (!isNaN(lat) && !isNaN(lon))
                            resolve({
                                lat,
                                lon,
                                city: json.city || '',
                                region: json.region || '',
                                country: json.country || '',
                            });
                        else
                            reject('Could not determine location');
                    } catch (e) { reject(e); }
                });
        });
    }

    _fetchWeather(lat, lon) {
        const isFahrenheit =
            this._settings?.get_string('temperature-unit') === 'fahrenheit';
        const params = {
            latitude: lat.toString(),
            longitude: lon.toString(),
            current: 'temperature_2m,weather_code,is_day,apparent_temperature',
            hourly: 'temperature_2m,weather_code,is_day,uv_index,precipitation_probability,apparent_temperature,relative_humidity_2m,wind_speed_10m',
            daily: 'temperature_2m_max,temperature_2m_min,precipitation_probability_max,sunrise,sunset,wind_speed_10m_max,wind_direction_10m_dominant',
            timezone: 'auto',
        };
        if (isFahrenheit)
            params.temperature_unit = 'fahrenheit';

        const paramsEncoded = Soup.form_encode_hash(params);
        const msg = Soup.Message.new_from_encoded_form('GET', WEATHER_API, paramsEncoded);
        msg.request_headers.append('Accept', 'application/json');

        return new Promise((resolve, reject) => {
            this._http.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, null,
                (_session, result) => {
                    try {
                        const bytes = this._http.send_and_read_finish(result);
                        const data = bytes?.get_data();
                        if (!data) { reject('No data'); return; }
                        const json = JSON.parse(new TextDecoder().decode(data));
                        const current = json?.current;
                        const hourly = json?.hourly;
                        const unit = isFahrenheit ? '°F' : '°C';
                        const now = new Date();
                        const currentHour = now.getHours();

                        if (hourly && hourly.time && hourly.temperature_2m && currentHour < hourly.temperature_2m.length) {
                            this._label.text = `${Math.round(hourly.temperature_2m[currentHour])}${unit}`;
                            this._icon.icon_name = this._iconName(hourly.weather_code[currentHour], hourly.is_day[currentHour] === 1);
                            this._pulseIcon();

                            const items = [];
                            let idx = currentHour;
                            for (let i = 0; idx < hourly.temperature_2m.length; i++, idx++) {
                                const hTemp = Math.round(hourly.temperature_2m[idx])
                                const hCode = hourly.weather_code[idx]
                                const hIsDay = hourly.is_day[idx] === 1
                                const hUv = Math.round(hourly.uv_index[idx] ?? 0)
                                const hPrecip = hourly.precipitation_probability?.[idx] ?? 0
                                const hFeels = Math.round(hourly.apparent_temperature?.[idx] ?? hTemp)
                                const hHumidity = Math.round(hourly.relative_humidity_2m?.[idx] ?? 0)
                                const hWind = Math.round(hourly.wind_speed_10m?.[idx] ?? 0)
                                const dt = new Date(now.getFullYear(), now.getMonth(), now.getDate(), idx);
                                const label = i === 0 ? 'Now' :
                                    dt.toLocaleString('en-US', {hour: 'numeric', hour12: true});
                                const dayKey = dt.toLocaleString('en-US', {weekday: 'long'});
                                items.push({
                                    label,
                                    temp: hTemp,
                                    iconCode: hCode,
                                    isDay: hIsDay,
                                    day: dayKey,
                                    hour: dt.getHours(),
                                    uv: hUv,
                                    precip: hPrecip,
                                    feels: hFeels,
                                    humidity: hHumidity,
                                    wind: hWind,
                                });
                            }
                            this._allForecast = items;
                            this._forecastPage = 0;

                            const daily = json?.daily;
                            if (daily && daily.time && daily.temperature_2m_max) {
                                // Daily icons use the most common hourly weather code (6am-11pm)
                                // rather than Open-Meteo's "most severe" daily code. This avoids
                                // showing a rain icon when only 2 hours of a day have drizzle.
                                const dayCodes = {};
                                if (hourly && hourly.time && hourly.weather_code) {
                                    for (let h = 0; h < hourly.time.length; h++) {
                                        const date = hourly.time[h].slice(0, 10);
                                        const hour = parseInt(hourly.time[h].slice(11, 13));
                                        if (hour >= 6 && hour < 24) {
                                            if (!dayCodes[date])
                                                dayCodes[date] = [];
                                            dayCodes[date].push(hourly.weather_code[h]);
                                        }
                                    }
                                }
                                const topCodes = (codes) => {
                                    if (!codes || codes.length === 0) return {primary: 0, secondary: 0, showBoth: false};
                                    const freq = {};
                                    for (const c of codes)
                                        freq[c] = (freq[c] || 0) + 1;
                                    const sorted = Object.entries(freq).sort((a, b) => b[1] - a[1] || b[0] - a[0]);
                                    const primary = parseInt(sorted[0][0]);
                                    const secondary = sorted.length > 1 ? parseInt(sorted[1][0]) : primary;
                                    const showBoth = sorted.length > 1 && sorted[1][1] >= sorted[0][1] * 0.4;
                                    return {primary, secondary, showBoth};
                                };

                                const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
                                const dailyItems = [];
                                for (let d = 0; d < daily.time.length; d++) {
                                    const date = daily.time[d];
                                    const dt = new Date(date + 'T12:00:00');
                                    const dayLabel = date === todayStr ? 'Today' :
                                        dt.toLocaleString('en-US', {weekday: 'short'});
                                    const tc = topCodes(dayCodes[date]);
                                    dailyItems.push({
                                        label: dayLabel,
                                        date: date,
                                        high: Math.round(daily.temperature_2m_max[d]),
                                        low: Math.round(daily.temperature_2m_min[d]),
                                        code: tc.primary,
                                        code2: tc.showBoth ? tc.secondary : null,
                                        precip: daily.precipitation_probability_max?.[d] ?? 0,
                                        sunrise: daily.sunrise?.[d] ?? '',
                                        sunset: daily.sunset?.[d] ?? '',
                                        windMax: Math.round(daily.wind_speed_10m_max?.[d] ?? 0),
                                        windDir: Math.round(daily.wind_direction_10m_dominant?.[d] ?? 0),
                                    });
                                }
                                this._allDaily = dailyItems;
                            }

                            this._rebuildMenu();
                        } else if (current) {
                            this._label.text = `${Math.round(current.temperature_2m)}${unit}`;
                            this._icon.icon_name = this._iconName(current.weather_code, current.is_day === 1);
                            this._pulseIcon();
                        }
                        resolve();
                    } catch (e) { reject(e); }
                });
        });
    }

    _rebuildDailyMenu() {
        const items = this._indicator.menu._getMenuItems();
        for (let i = items.length - 1; i >= 0; i--)
            items[i].destroy();

        const unit = (this._settings?.get_string('temperature-unit') === 'fahrenheit')
            ? '°F' : '°C';

        const tempColor = (t) => {
            const isF = unit === '°F';
            if (isF) {
                if (t < 32) return '#64b5f6';
                if (t < 50) return '#42a5f5';
                if (t < 65) return '#26a69a';
                if (t < 75) return '#66bb6a';
                if (t < 85) return '#ffca28';
                if (t < 95) return '#ffa726';
                return '#ef5350';
            }
            if (t < 0) return '#64b5f6';
            if (t < 10) return '#42a5f5';
            if (t < 18) return '#26a69a';
            if (t < 24) return '#66bb6a';
            if (t < 30) return '#ffca28';
            if (t < 35) return '#ffa726';
            return '#ef5350';
        };

        if (this._location) {
            let subtitle = '7-Day Forecast';
            if (this._allDaily.length >= 2) {
                const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
                const first = new Date(this._allDaily[0].date + 'T12:00:00');
                const last = new Date(this._allDaily[this._allDaily.length - 1].date + 'T12:00:00');
                const fStr = `${months[first.getMonth()]} ${first.getDate()}`;
                const lStr = `${months[last.getMonth()]} ${last.getDate()}`;
                subtitle = `${fStr} — ${lStr}`;
            }
            this._addHeader(subtitle);
        }

        if (this._allDaily.length > 0) {
            const allLows = this._allDaily.map(d => d.low);
            const allHighs = this._allDaily.map(d => d.high);
            const weekMin = Math.min(...allLows);
            const weekMax = Math.max(...allHighs);
            const weekRange = weekMax - weekMin || 1;
            const barTotalPx = 100;

            const bgContainer = new St.BoxLayout({
                style_class: 'weather-bg-box',
                vertical: true,
                opacity: 0,
            });

            for (let i = 0; i < this._allDaily.length; i++) {
                const day = this._allDaily[i];
                const row = new St.BoxLayout({
                    x_expand: true,
                    style: 'padding: 4px 10px; spacing: 6px;',
                });
                if (i % 2 === 0)
                    row.style = 'padding: 4px 10px; spacing: 6px; background-color: rgba(255,255,255,0.04);';

                const dayLabel = new St.Label({
                    text: day.label,
                    style: 'font-size: 12px; font-weight: bold; min-width: 36px; color: #eee;',
                    y_align: Clutter.ActorAlign.CENTER,
                });
                row.add_child(dayLabel);

                const icon = new St.Icon({
                    icon_name: this._iconName(day.code, true),
                    style: 'icon-size: 16px; min-width: 20px;',
                    y_align: Clutter.ActorAlign.CENTER,
                });
                row.add_child(icon);

                const precipColor = '#64b5f6';
                row.add_child(new St.Label({
                    text: `${day.precip}%`,
                    style: `font-size: 10px; color: ${precipColor}; min-width: 26px;`,
                    y_align: Clutter.ActorAlign.CENTER,
                }));

                const loLabel = new St.Label({
                    text: `${day.low}°`,
                    style: 'font-size: 11px; color: #999; min-width: 24px;',
                    x_align: Clutter.ActorAlign.END,
                    y_align: Clutter.ActorAlign.CENTER,
                });
                row.add_child(loLabel);

                const loPct = ((day.low - weekMin) / weekRange) * 100;
                const hiPct = ((day.high - weekMin) / weekRange) * 100;
                const leftPad = Math.max(0, Math.round(loPct / 100 * barTotalPx));
                const rightPad = Math.max(0, barTotalPx - leftPad - Math.max(Math.round((hiPct - loPct) / 100 * barTotalPx), 6));

                const track = new St.BoxLayout({
                    x_expand: true,
                    y_align: Clutter.ActorAlign.CENTER,
                    style: `min-height: 4px; border-radius: 2px; background-color: rgba(255,255,255,0.12);`,
                });
                if (leftPad > 0)
                    track.add_child(new St.Bin({style: `min-width: ${leftPad}px;`}));

                const lowColor = tempColor(day.low);
                const highColor = tempColor(day.high);
                const segments = 8;
                const lR = parseInt(lowColor.slice(1, 3), 16);
                const lG = parseInt(lowColor.slice(3, 5), 16);
                const lB = parseInt(lowColor.slice(5, 7), 16);
                const hR = parseInt(highColor.slice(1, 3), 16);
                const hG = parseInt(highColor.slice(3, 5), 16);
                const hB = parseInt(highColor.slice(5, 7), 16);
                const totalBarPx = barTotalPx - leftPad - rightPad;
                const segW = Math.max(Math.round(totalBarPx / segments), 2);
                for (let s = 0; s < segments; s++) {
                    const t = s / (segments - 1 || 1);
                    const r = Math.round(lR + (hR - lR) * t);
                    const g = Math.round(lG + (hG - lG) * t);
                    const b = Math.round(lB + (hB - lB) * t);
                    const w = s < segments - 1 ? segW : Math.max(totalBarPx - segW * (segments - 1), 2);
                    track.add_child(new St.Bin({
                        style: `min-width: ${w}px; min-height: 4px; background-color: rgb(${r},${g},${b});${s === 0 ? ' border-radius: 2px 0 0 2px;' : ''}${s === segments - 1 ? ' border-radius: 0 2px 2px 0;' : ''}`,
                    }));
                }
                if (rightPad > 0)
                    track.add_child(new St.Bin({style: `min-width: ${rightPad}px;`}));
                row.add_child(track);

                const hiLabel = new St.Label({
                    text: `${day.high}°`,
                    style: 'font-size: 11px; font-weight: bold; color: #eee; min-width: 24px;',
                    y_align: Clutter.ActorAlign.CENTER,
                });
                row.add_child(hiLabel);

                row.reactive = true;
                row.track_hover = true;
                row.connect('enter-event', () => { row.opacity = 180; this._showTooltip(row, day, unit, unit === '°F'); });
                row.connect('leave-event', () => { row.opacity = 255; this._hideTooltip(); });
                row.connect('button-press-event', () => {
                    const now = new Date();
                    const todayName = now.toLocaleString('en-US', {weekday: 'long'});
                    const shorts = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
                    const weekdays = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
                    const idx = shorts.indexOf(day.label);
                    const targetDay = day.label === 'Today' ? todayName :
                        idx >= 0 ? weekdays[idx] : todayName;
                    this._activeDay = targetDay;
                    this._forecastPage = 0;
                    this._viewMode = 'hourly';
                    this._fadeToPage();
                    return Clutter.EVENT_STOP;
                });

                const rowItem = new PopupMenu.PopupBaseMenuItem({reactive: false});
                rowItem.add_child(row);
                bgContainer.add_child(rowItem);
            }

            const toggleRow2 = new St.BoxLayout({
                x_expand: true,
                x_align: Clutter.ActorAlign.CENTER,
                style: 'padding: 2px 6px 4px 6px;',
            });
            const toggleBtn2 = new St.Button({
                child: new St.Icon({
                    icon_name: this._activeDay ? 'view-day-symbolic' : 'preferences-system-time-symbolic',
                    style: 'icon-size: 14px;',
                }),
                reactive: true,
                can_focus: true,
                track_hover: true,
                style: 'padding: 2px 8px; border-radius: 4px;',
            });
            toggleBtn2.connect('button-press-event', () => {
                this._activeDay = null;
                this._forecastPage = 0;
                this._viewMode = 'hourly';
                this._fadeToPage();
                return Clutter.EVENT_STOP;
            });
            toggleRow2.add_child(toggleBtn2);
            const toggleItem2 = new PopupMenu.PopupBaseMenuItem({reactive: false});
            toggleItem2.add_child(toggleRow2);
            bgContainer.add_child(new PopupMenu.PopupSeparatorMenuItem());
            bgContainer.add_child(toggleItem2);

            this._bgContainer = bgContainer;
            const bgItem = new PopupMenu.PopupBaseMenuItem({reactive: false});
            bgItem.add_child(bgContainer);
            this._indicator.menu.addMenuItem(bgItem);

            if (this._rebuildDelayId > 0) {
                GLib.Source.remove(this._rebuildDelayId);
                this._rebuildDelayId = 0;
            }
            this._rebuildDelayId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 10, () => {
                this._rebuildDelayId = 0;
                let fi = 0;
                const fiSteps = 6;
                if (this._rebuildFadeInId > 0) {
                    GLib.Source.remove(this._rebuildFadeInId);
                    this._rebuildFadeInId = 0;
                }
                this._rebuildFadeInId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 15, () => {
                    fi++;
                    if (this._bgContainer) {
                        this._bgContainer.opacity = Math.round(255 * (fi / fiSteps));
                    }
                    if (fi >= fiSteps)
                        this._rebuildFadeInId = 0;
                    return fi < fiSteps ? GLib.SOURCE_CONTINUE : GLib.SOURCE_REMOVE;
                });
                return GLib.SOURCE_REMOVE;
            });
        }
    }

    disable() {
        if (this._timeoutId > 0) {
            GLib.Source.remove(this._timeoutId);
            this._timeoutId = 0;
        }
        if (this._pulseTimeoutId > 0) {
            GLib.Source.remove(this._pulseTimeoutId);
            this._pulseTimeoutId = 0;
        }
        if (this._fadeTimeoutId > 0) {
            GLib.Source.remove(this._fadeTimeoutId);
            this._fadeTimeoutId = 0;
        }
        if (this._menuFadeInId > 0) {
            GLib.Source.remove(this._menuFadeInId);
            this._menuFadeInId = 0;
        }
        if (this._rebuildFadeInId > 0) {
            GLib.Source.remove(this._rebuildFadeInId);
            this._rebuildFadeInId = 0;
        }
        if (this._rebuildDelayId > 0) {
            GLib.Source.remove(this._rebuildDelayId);
            this._rebuildDelayId = 0;
        }
        this._settings?.disconnectObject(this);
        if (this._indicator?.menu)
            this._indicator.menu.disconnectObject(this);
        this._http?.abort();
        this._http = null;
        this._settings = null;
        this._allForecast = [];
        this._allDaily = [];
        this._activeDay = null;
        this._location = '';
        this._hideTooltip();
        this._bgContainer?.destroy();
        this._bgContainer = null;
        this._box?.destroy();
        this._box = null;
        this._icon?.destroy();
        this._icon = null;
        this._label?.destroy();
        this._label = null;
        this._indicator?.destroy();
        this._indicator = null;
    }
}
