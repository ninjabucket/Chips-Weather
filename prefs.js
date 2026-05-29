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
