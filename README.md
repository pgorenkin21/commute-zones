# 🗺️ Commute Zones

**Where in London should we live so that *everyone* gets to work on time?**

Add each person's workplace, pick a maximum commute, and Commute Zones colours the map with every neighbourhood that works for the whole group, along with typical rents.

### 👉 [Try it live](https://pgorenkin21.github.io/commute-zones/)

![Commute Zones showing the neighbourhoods that work for three people commuting to King's Cross, Canary Wharf and Westminster](docs/screenshot.png)

---

## ✨ What it does

- **👥 Many people, one answer.** Add as many people as you like. Give each one a workplace (a postcode, an address, or a click on the map) and, if you want, their own commute limit.
- **🚇 Real TfL journey times.** Times come from the TfL Journey Planner for a typical Tuesday to Thursday morning, door to door with walking included. You choose the arrival time and which modes count: Tube, bus, Overground, Elizabeth line, DLR, National Rail and tram.
- **🟩 A heatmap of where works.** London is split into a hex grid. Dark green means quick for everyone, amber means someone is right on their limit, and red means it's too far for someone.
- **🏘️ A ranked list of neighbourhoods.** Areas that work are grouped by ward and sorted by shortest worst-case commute or by cheapest rent. Click one to zoom to it.
- **💷 Rents built in.** Median rents actually paid, by postcode district, from the ONS (April 2025 to March 2026). They cover everything from a room in a shared house to 4+ bedrooms. Set a budget and areas you can't afford are greyed out.
- **⚡ Quick to run again.** Results are cached in your browser, the most promising areas are checked first, and areas that are clearly too far away are skipped without asking TfL.

## 🚀 Using it

Open the **[live site](https://pgorenkin21.github.io/commute-zones/)**. There's nothing to install and no sign-up.

1. Add a person and type in their workplace.
2. Set the max commute and the time you need to arrive by.
3. Click **Find zones** and watch the map fill in.

> **Tip:** without an API key, TfL lets you make only about one lookup every 2–3 seconds. Get a **free** key at [api-portal.tfl.gov.uk](https://api-portal.tfl.gov.uk/) and paste it under *TfL API key*. Searches will be roughly 8× faster. The key is saved only in your own browser.

### Running it locally

It's a plain static site with no build step:

```bash
git clone https://github.com/pgorenkin21/commute-zones.git
cd commute-zones
python3 -m http.server 8765   # then open http://localhost:8765
```

On a Mac you can also just double-click `start.command`.

## 🛠️ How it's built

| | |
|---|---|
| Map | [Leaflet](https://leafletjs.com/) + [OpenStreetMap](https://www.openstreetmap.org/) tiles |
| Journeys | [TfL Unified API](https://api.tfl.gov.uk/) Journey Planner |
| Geocoding | [postcodes.io](https://postcodes.io/) and [Nominatim](https://nominatim.openstreetmap.org/) |
| Rents | ONS, *Private Rental Market in London*, April 2025 to March 2026 |
| Code | Vanilla HTML, CSS and JS with no framework and no build step |

## 🙏 Credits

Journey data © Transport for London. Map data © OpenStreetMap contributors. Rent data © Office for National Statistics, Open Government Licence v3.0.
