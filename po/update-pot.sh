#!/bin/sh
# Regenerate po/chips-weather.pot from the sources, then merge into the
# translations:   msgmerge -U po/pt_BR.po po/chips-weather.pot
cd "$(dirname "$0")/.." || exit 1
xgettext --from-code=UTF-8 \
    --keyword=_ --keyword=N_ --keyword=C_:1c,2 --keyword=NC_:1c,2 \
    --package-name="Chips Weather" \
    --copyright-holder="chip" \
    --msgid-bugs-address="https://github.com/ninjabucket/Chips-Weather/issues" \
    -o po/chips-weather.pot \
    extension.js prefs.js
