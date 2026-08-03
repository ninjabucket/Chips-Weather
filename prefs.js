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
import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

export default class WeatherPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        window.default_width = 460;

        const page = new Adw.PreferencesPage();
        window.add(page);

        const settings = this.getSettings();

        const unitGroup = new Adw.PreferencesGroup({title: 'Units'});
        page.add(unitGroup);

        const unitRow = new Adw.ComboRow({
            title: 'Temperature Unit',
            subtitle: 'Choose Celsius or Fahrenheit',
            model: Gtk.StringList.new(['Celsius', 'Fahrenheit']),
            selected: settings.get_string('temperature-unit') === 'fahrenheit' ? 1 : 0,
        });
        unitRow.connect('notify::selected', () => {
            settings.set_string(
                'temperature-unit',
                unitRow.selected === 1 ? 'fahrenheit' : 'celsius',
            );
        });
        unitGroup.add(unitRow);

        // ---- Layout ----
        const layoutGroup = new Adw.PreferencesGroup({title: 'Layout'});
        page.add(layoutGroup);

        const posRow = new Adw.ComboRow({
            title: 'Temperature Position',
            subtitle: 'Show temperature on the left or right of the icon',
            model: Gtk.StringList.new(['Left', 'Right']),
            selected: settings.get_string('temperature-position') === 'right' ? 1 : 0,
        });
        posRow.connect('notify::selected', () => {
            settings.set_string(
                'temperature-position',
                posRow.selected === 1 ? 'right' : 'left',
            );
        });
        layoutGroup.add(posRow);

        const colorRow = new Adw.SwitchRow({
            title: 'Dynamic Temperature Color',
            subtitle: 'Blue-to-red gradient in forecast rows',
            active: settings.get_boolean('use-colored-temps'),
        });
        colorRow.connect('notify::active', () => {
            settings.set_boolean('use-colored-temps', colorRow.active);
        });
        layoutGroup.add(colorRow);

        const uvColorRow = new Adw.SwitchRow({
            title: 'Dynamic UV Color',
            subtitle: 'Color-coded UV index labels',
            active: settings.get_boolean('use-colored-uv'),
        });
        uvColorRow.connect('notify::active', () => {
            settings.set_boolean('use-colored-uv', uvColorRow.active);
        });
        layoutGroup.add(uvColorRow);

        const locGroup = new Adw.PreferencesGroup({title: 'Location'})
        page.add(locGroup)

        const sourceRow = new Adw.ComboRow({
            title: 'Location Source',
            subtitle: 'Auto detects via IP, manual uses postal code',
            model: Gtk.StringList.new(['Auto (IP)', 'Manual (Postal Code)']),
            selected: settings.get_string('location-mode') === 'manual' ? 1 : 0,
        })
        const manualRows = []
        sourceRow.connect('notify::selected', () => {
            const mode = sourceRow.selected === 1 ? 'manual' : 'auto'
            settings.set_string('location-mode', mode)
            for (const r of manualRows) r.visible = mode === 'manual'
        })
        locGroup.add(sourceRow)

        const postalRow = new Adw.EntryRow({
            title: 'Postal Code',
            text: settings.get_string('manual-postal-code'),
        })
        postalRow.connect('notify::text', () => {
            settings.set_string('manual-postal-code', postalRow.text)
        })
        postalRow.visible = settings.get_string('location-mode') === 'manual'
        locGroup.add(postalRow)
        manualRows.push(postalRow)

        const countryRow = new Adw.EntryRow({
            title: 'Country (ISO-2)',
            text: settings.get_string('manual-country'),
        })
        countryRow.connect('notify::text', () => {
            settings.set_string('manual-country', countryRow.text)
        })
        countryRow.visible = settings.get_string('location-mode') === 'manual'
        locGroup.add(countryRow)
        manualRows.push(countryRow)

        const cachedMode = settings.get_string('location-mode') === 'manual'
        const cachedKey = cachedMode ? 'manual-location-cache' : 'location-cache'
        const cached = settings.get_string(cachedKey)
        const locRow = new Adw.ActionRow({
            title: cachedMode ? 'Resolved Manual Location' : 'Cached Location',
            subtitle: cached
                ? cached.split('|')[1] || 'detected'
                : 'not cached — auto-detects on next refresh',
        })
        locGroup.add(locRow)

        const redetectBtn = new Gtk.Button({
            label: 'Re-detect Location',
            tooltip_text: 'Clears cached locations; next refresh re-resolves',
            valign: Gtk.Align.CENTER,
        })
        redetectBtn.connect('clicked', () => {
            settings.set_string('location-cache', '')
            settings.set_string('manual-location-cache', '')
        })
        locRow.add_suffix(redetectBtn)

        const displayGroup = new Adw.PreferencesGroup({title: 'Display'});
        page.add(displayGroup);

        const uvShowRow = new Adw.SwitchRow({
            title: 'Show UV Index',
            subtitle: 'Display UV index in hourly forecast rows',
            active: settings.get_boolean('show-uv-index'),
        });
        uvShowRow.connect('notify::active', () => {
            settings.set_boolean('show-uv-index', uvShowRow.active);
        });
        displayGroup.add(uvShowRow);

        const precipShowRow = new Adw.SwitchRow({
            title: 'Show Rain Chance',
            subtitle: 'Display precipitation probability in hourly forecast rows',
            active: settings.get_boolean('show-precipitation'),
        });
        precipShowRow.connect('notify::active', () => {
            settings.set_boolean('show-precipitation', precipShowRow.active);
        });
        displayGroup.add(precipShowRow);
    }
}
