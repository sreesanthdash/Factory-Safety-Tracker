# Design: Factory safety console

The locked system. Every Hallmark run reads this first and the pages share it. Change it on purpose; this file is the rule.

## System
- Genre: modern-minimal
- Shape of the first page: app screen with a site overview
- Theme: Vantage
- Axes: dark / grotesk sans / chromatic lime · posture: restrained
- Theme dials: terrain / steel
- Safety states: red for open alerts, amber for acknowledged or delayed, green for confirmed or reporting; lime remains the product accent.
- Audience: factory workers, safety officers, and the administrator
- Product boundary: synthetic incident and device examples; no live factory connection

## Tokens
tokens.css is the source of truth. It defines the steel paper surfaces, pale ink, lime signal, Geologica type, spacing scale, and motion timings.

## Screens
- **Login:** compact sign-in panel beside a review-sequence explanation.
- **Overview:** site metrics, zone links, recent-signal table, and charts derived from sample detector signals, review outcomes, and worker references.
- **Incidents:** filterable signal list beside source details, human review trail, and actions.
- **Devices:** sample device table with zone filtering.
- **Users:** administrator account table, role summary, and account editor.

Pages share one top navigation and route frame. The Users route is visible only to administrators. Direct access is checked again by the API.

## Controls
- Primary: lime fill, square-corner frame, 42 to 48px height.
- Secondary: transparent steel outline.
- Inputs: paper-2 surface, one-pixel steel frame, lime focus ring.
- Panels: flat, instrument-like surfaces with steel rules, compact chart labels, and restrained camera-monitor cues; no fabricated live footage or detection overlay.

## Motion
- Character: calm; short colour and 1px lift transitions on hover.
- No reveal animation. Reduced-motion settings disable transitions and the loading indicator.

## Data and states
- Detector output and human decisions stay distinct in the incident trail.
- Every signal and device is labelled as sample data. Overview charts count those same local records; they do not imply compliance scores, real-time monitoring, or measured trends.
- Loading, empty, error, permission, active, acknowledged, confirmed, and dismissed states are represented.
- Login and administrative actions return inline status messages.

## Exports
tokens.css in this project.
