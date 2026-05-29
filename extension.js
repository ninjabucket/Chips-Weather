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
//  Data flow: ipapi.co (geolocate by IP) → open-meteo.com (48h hourly + 7d daily) → panel + popup.
//  GJS module system: uses gi:// imports (Soup 3.0 required) and resource:/// for GNOME Shell APIs.
//  No npm, no fetch(), no Node.js — Soup.Session with Promise wrappers for async HTTP.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup';
import St from 'gi://St';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

const WEATHER_API = 'https://api.open-meteo.com/v1/forecast';
const GEO_API = 'https://ipapi.co/json/';

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
        const perPage = 8;
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

        if (this._location) {
            const headerItem = new PopupMenu.PopupBaseMenuItem({reactive: false});
            const headerRow = new St.BoxLayout({x_expand: true});

            const locBox = new St.BoxLayout({vertical: true, x_align: Clutter.ActorAlign.START});
            const locLabel = new St.Label({
                text: this._location,
                style: 'font-weight: bold; padding: 0 4px;',
            });
            locBox.add_child(locLabel);

            if (this._allDaily.length > 0) {
                const firstItem = forecast[this._forecastPage * perPage];
                const pageDay = firstItem ? firstItem.day : this._allDaily[0]?.date;
                let headerDay = this._allDaily[0];
                if (pageDay) {
                    const weekdays = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
                    const shorts = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
                    const dayIdx = weekdays.indexOf(pageDay);
                    const shortName = dayIdx >= 0 ? shorts[dayIdx] : null;
                    for (const d of this._allDaily) {
                        if (d.label === 'Today' && pageDay === new Date().toLocaleString('en-US', {weekday: 'long'}))
                            { headerDay = d; break; }
                        if (d.label === shortName)
                            { headerDay = d; break; }
                    }
                }
                const headerIconBox = new St.BoxLayout({x_align: Clutter.ActorAlign.CENTER});
                const todayIcon = new St.Icon({
                    icon_name: this._iconName(headerDay.code, true),
                    style: 'icon-size: 32px; ',
                });
                headerIconBox.add_child(todayIcon);
                if (headerDay.code2) {
                    const slash = new St.Label({
                        text: '/',
                        style: 'font-size: 14px; color: #555; padding: 0 2px;',
                        y_align: Clutter.ActorAlign.CENTER,
                    });
                    const todayIcon2 = new St.Icon({
                        icon_name: this._iconName(headerDay.code2, true),
                        style: 'icon-size: 24px; color: #888;',
                    });
                    headerIconBox.add_child(slash);
                    headerIconBox.add_child(todayIcon2);
                }
                const gap = new St.Bin({style: 'width: 12px;'});
                headerRow.add_child(headerIconBox);
                headerRow.add_child(gap);
                headerRow.add_child(locBox);
            } else {
                headerRow.add_child(locBox);
            }

            headerItem.add_child(headerRow);
            this._indicator.menu.addMenuItem(headerItem);

            if (this._allForecast.length > 0) {
                const todayDay = this._allForecast[0]?.day || '';

                const headerItems = forecast.slice(
                    this._forecastPage * perPage, this._forecastPage * perPage + perPage,
                );
                const days = [...new Set(headerItems.map(f => f.day).filter(Boolean))];
                const labels = days.map(d => d === todayDay ? 'Today' : d);
                const dayText = labels.join(' & ');
                const dayLabel = new St.Label({
                    text: dayText,
                    style: 'font-size: 10px; color: #aaa; padding: 0 4px;',
                });
                locBox.add_child(dayLabel);
            }
        }

        if (this._allForecast.length > 0) {
            const unit = (this._settings?.get_string('temperature-unit') === 'fahrenheit')
                ? '°F' : '°C';
            const perPage = 8;
            const useColors = this._settings?.get_boolean('use-colored-temps') !== false;
            const useUvColors = this._settings?.get_boolean('use-colored-uv') !== false;
            const showUv = this._settings?.get_boolean('show-uv-index') !== false;
            const showPrecip = this._settings?.get_boolean('show-precipitation') !== false;

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
                const row = new St.BoxLayout({style_class: 'weather-forecast-row', x_expand: true});
                if (i % 2 === 0)
                    row.style = 'background-color: rgba(255, 255, 255, 0.04);';
                const tl = new St.Label({
                    text: pageItems[i].label, style: 'font-size: 12px; font-weight: bold; min-width: 40px;',
                    x_align: Clutter.ActorAlign.START,
                    y_align: Clutter.ActorAlign.CENTER,
                });
                const ic = new St.Icon({
                    icon_name: this._iconName(pageItems[i].iconCode, pageItems[i].isDay), style_class: 'weather-forecast-icon', style: 'color: rgba(255,255,255,0.85);',
                    y_align: Clutter.ActorAlign.CENTER,
                });
                const t = pageItems[i].temp;
                let tempColor = '#fff';
                if (useColors) {
                    const isF = unit === '°F';
                    if (isF) {
                        if (t < 32) tempColor = '#64b5f6';
                        else if (t < 50) tempColor = '#42a5f5';
                        else if (t < 65) tempColor = '#26a69a';
                        else if (t < 75) tempColor = '#66bb6a';
                        else if (t < 85) tempColor = '#ffca28';
                        else if (t < 95) tempColor = '#ffa726';
                        else tempColor = '#ef5350';
                    } else {
                        if (t < 0) tempColor = '#64b5f6';
                        else if (t < 10) tempColor = '#42a5f5';
                        else if (t < 18) tempColor = '#26a69a';
                        else if (t < 24) tempColor = '#66bb6a';
                        else if (t < 30) tempColor = '#ffca28';
                        else if (t < 35) tempColor = '#ffa726';
                        else tempColor = '#ef5350';
                    }
                }
                const tp = new St.Label({
                    text: `${t}${unit}`, style: `font-size: 12px; font-weight: bold; color: ${tempColor};`,
                    x_align: Clutter.ActorAlign.END,
                    y_align: Clutter.ActorAlign.CENTER,
                });
                const rightBox = new St.BoxLayout({style: 'spacing: 4px;'});
                rightBox.add_child(ic);
                rightBox.add_child(tp);
                const detailBox = new St.BoxLayout({x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER, style: 'min-width: 60px;'});
                if (pageItems[i].isDay) {
                    const uv = pageItems[i].uv;
                    let uvLabel = '', uvColor = '#fff';
                    if (useUvColors) {
                        if (uv <= 2) { uvLabel = 'Low'; uvColor = '#8bc34a'; }
                        else if (uv <= 5) { uvLabel = 'Mod'; uvColor = '#ffc107'; }
                        else if (uv <= 7) { uvLabel = 'High'; uvColor = '#ff9800'; }
                        else if (uv <= 10) { uvLabel = 'V.High'; uvColor = '#f44336'; }
                        else { uvLabel = 'Extr'; uvColor = '#ce93d8'; }
                    }
                    const uvText = new St.Label({
                        text: useUvColors ? `UV ${uv} ${uvLabel}` : `UV ${uv}`,
                        style: `font-size: 10px; font-weight: bold; min-width: 54px; color: ${uvColor};`,
                        x_align: Clutter.ActorAlign.CENTER,
                        y_align: Clutter.ActorAlign.CENTER,
                    });
                    detailBox.add_child(uvText);
                } else {
                    const moonIcon = new St.Icon({
                        icon_name: 'weather-clear-night-symbolic',
                        style_class: 'weather-precip-icon',
                        x_align: Clutter.ActorAlign.CENTER,
                    });
                    detailBox.add_child(moonIcon);
                }
                const precipBox = new St.BoxLayout({x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER, style: 'spacing: 2px; min-width: 40px;'});
                const precipIcon = new St.Icon({
                    icon_name: 'weather-showers-symbolic',
                    style_class: 'weather-precip-icon',
                });
                const precipLabel = new St.Label({
                    text: `${pageItems[i].precip}%`,
                    style: 'font-size: 11px; font-weight: bold;',
                });
                precipBox.add_child(precipIcon);
                precipBox.add_child(precipLabel);
                if (showPrecip)
                    precipBox.visible = pageItems[i].precip > 0;
                row.add_child(tl);
                if (showUv)
                    row.add_child(detailBox);
                if (showPrecip) {
                    if (pageItems[i].precip <= 0) {
                        precipIcon.visible = false;
                        precipLabel.text = '';
                    }
                    row.add_child(precipBox);
                }
                row.add_child(new St.Bin({x_expand: true}));
                row.add_child(rightBox);
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
                const isUS = loc.country === 'United States';
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
                        if (json.latitude && json.longitude)
                            resolve({
                                lat: json.latitude,
                                lon: json.longitude,
                                city: json.city || '',
                                region: json.region || '',
                                country: json.country_name || '',
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
            current: 'temperature_2m,weather_code,is_day',
            hourly: 'temperature_2m,weather_code,is_day,uv_index,precipitation_probability',
            daily: 'temperature_2m_max,temperature_2m_min,precipitation_probability_max',
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
                                    uv: hUv,
                                    precip: hPrecip,
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
        const useColors = this._settings?.get_boolean('use-colored-temps') !== false;

        if (this._location) {
            const locItem = new PopupMenu.PopupBaseMenuItem({reactive: false});
            const headerRow = new St.BoxLayout({x_expand: true});

            if (this._allDaily.length > 0) {
                const todayIcon = new St.Icon({
                    icon_name: this._iconName(this._allDaily[0].code, true),
                    style: 'icon-size: 32px; ',
                });
                const gap = new St.Bin({style: 'width: 12px;'});
                headerRow.add_child(todayIcon);
                headerRow.add_child(gap);
            }

            const locBox = new St.BoxLayout({vertical: true, x_align: Clutter.ActorAlign.START});
            const locLabel = new St.Label({
                text: this._location,
                style: 'font-weight: bold; padding: 0 4px;',
            });
            locBox.add_child(locLabel);
            const weekLabel = new St.Label({
                text: 'Weekly',
                style: 'font-size: 10px; color: #aaa; padding: 0 4px;',
            });
            locBox.add_child(weekLabel);
            headerRow.add_child(locBox);
            locItem.add_child(headerRow);
            this._indicator.menu.addMenuItem(locItem);
        }

        if (this._allDaily.length > 0) {
            const bgContainer = new St.BoxLayout({
                style_class: 'weather-bg-box',
                vertical: true,
                opacity: 0,
            });

            for (let i = 0; i < this._allDaily.length; i++) {
                const day = this._allDaily[i];
                const row = new St.BoxLayout({style_class: 'weather-forecast-row', x_expand: true});
                if (i % 2 === 0)
                    row.style = 'background-color: rgba(255, 255, 255, 0.04);';

                const dayLabel = new St.Label({
                    text: day.label,
                    style: 'font-size: 12px; font-weight: bold; min-width: 42px;',
                    x_align: Clutter.ActorAlign.START,
                    y_align: Clutter.ActorAlign.CENTER,
                });

                const iconBox = new St.BoxLayout({x_align: Clutter.ActorAlign.CENTER});
                const dayIcon = new St.Icon({
                    icon_name: this._iconName(day.code, true),
                    style: 'icon-size: 20px; ',
                    y_align: Clutter.ActorAlign.CENTER,
                });
                iconBox.add_child(dayIcon);
                if (day.code2) {
                    const slash = new St.Label({
                        text: '/',
                        style: 'font-size: 11px; color: #555; padding: 0 1px;',
                        y_align: Clutter.ActorAlign.CENTER,
                    });
                    const dayIcon2 = new St.Icon({
                        icon_name: this._iconName(day.code2, true),
                        style: 'icon-size: 16px; color: #888;',
                    });
                    iconBox.add_child(slash);
                    iconBox.add_child(dayIcon2);
                }

                const tempColor = (t, isF) => {
                    if (!useColors) return '#fff';
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
                const isF = unit === '°F';
                const hiLoBox = new St.BoxLayout({x_align: Clutter.ActorAlign.CENTER});
                const hiLabel = new St.Label({
                    text: `H:${day.high}°`,
                    style: `font-size: 11px; font-weight: bold; color: ${tempColor(day.high, isF)};`,
                    y_align: Clutter.ActorAlign.CENTER,
                });
                const loLabel = new St.Label({
                    text: ` L:${day.low}°`,
                    style: `font-size: 11px; font-weight: bold; color: ${tempColor(day.low, isF)};`,
                    y_align: Clutter.ActorAlign.CENTER,
                });
                hiLoBox.add_child(hiLabel);
                hiLoBox.add_child(loLabel);

                const precipBox = new St.BoxLayout({x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER});
                const precipIcon = new St.Icon({
                    icon_name: 'weather-showers-symbolic',
                    style_class: 'weather-precip-icon',
                });
                const precipLabel = new St.Label({
                    text: `${day.precip}%`,
                    style: 'font-size: 11px; font-weight: bold;',
                });
                precipBox.add_child(precipIcon);
                precipBox.add_child(precipLabel);

                const s1 = new St.Bin({x_expand: true});
                const s2 = new St.Bin({x_expand: true});
                const s3 = new St.Bin({x_expand: true});
                row.add_child(dayLabel);
                row.add_child(s1);
                row.add_child(iconBox);
                row.add_child(s2);
                row.add_child(hiLoBox);
                row.add_child(s3);
                row.add_child(precipBox);
                row.reactive = true;
                row.track_hover = true;
                row.connect('enter-event', () => { row.opacity = 180; });
                row.connect('leave-event', () => { row.opacity = 255; });
                row.connect('button-press-event', () => {
                    const now = new Date();
                    const todayName = now.toLocaleString('en-US', {weekday: 'long'});
                    const weekdays = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
                    const shorts = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
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
                    icon_name: 'preferences-system-time-symbolic',
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
