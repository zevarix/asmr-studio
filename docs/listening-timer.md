# Listening timer and gradual fades

Open **Listening timer** beside the playback controls and choose **On**. Set
**Stop after**, **Fade in**, and **Fade out** in minutes, then press **Apply timer**.
Fractions work: 0.5 minutes is 30 seconds. The initial settings are 45 minutes,
no long fade-in, and a 3-minute fade-out. The timer starts Off in a new session.

The duration must be positive. Fades can be zero, and their combined length
must fit within the duration. For example, a 10-minute session can have a
1-minute fade-in and a 3-minute fade-out. Two 5-minute fades create a continuous
rise and fall with no full-volume interval in between. Invalid entries stay
visible for correction and leave the applied settings alone.

Numeric changes apply together. Selecting **Off** immediately removes the
listening deadline and retains the last applied values for next time.

## While listening

The collapsed timer shows time remaining and whether the mix is fading. It
counts actual playback time: **Pause** holds the time and fade, and **Start
listening** continues from that point. **Stop** resets the playback position;
the next start begins the timer and fade-in again. When the timer finishes,
the mix ends at its deadline and the next start begins a fresh session.

Changing only a fade keeps the sounds and playback clock running. The output
blends into the new curve over 20 ms. Changing the duration preserves the
elapsed time and sound positions, with the same short transition used by
other live edits. A new stop time that has already passed ends the current
playback with a short fade. Loading another saved session uses that session's
own timer and starts at the beginning.

Long fades affect the whole output after the peak limiter, so even a loud mix
fades steadily. The final output meters include the fade. A recording set to
play once still ends naturally; the timer does not stretch or repeat it. The
rest of a timed session can therefore be silent.

## Saving and exporting

Timer settings follow **Save session**, **Save a copy**, and reopening a session.
The current countdown is playback state and is not saved. Watching the timer
does not mark the session as changed.

A WAV starts from the beginning and uses the duration selected in **Export
mix** as its endpoint. An enabled timer contributes its saved fade lengths,
applied at that file's beginning and end. For example, exporting a 45-minute
session as 10 minutes with a 3-minute fade-out starts fading at minute 7 and
ends at minute 10. If the fade lengths cannot fit in the selected export
duration, the studio asks you to change them before starting the export.

Turning the timer Off disables its long fades in exports too. The original
saved settings remain in **Recipe & credits**, along with the separately
selected export duration. Editing a session later cannot change an export
that has already been accepted.

## Timing details

The audio clock schedules the fade and final silence. Display updates only
report progress; a delayed display callback does not extend the sound beyond
the deadline. An interrupted audio context holds the listening clock until
playback resumes. The existing short source envelopes still prevent abrupt
source starts and stops, independently of the selected long fades.

Browser and device power-management behavior is separate. Phone background
and screen-off playback still need actual-device checks; this is a listening
timer, not a system alarm.
