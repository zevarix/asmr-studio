# Transition between saved mixes

Choose **New transition** beside the session controls. If the current mix has
unsaved changes, save or discard those changes before opening the new
arrangement. Give it a name, then choose **Mix A** and **Mix B** from your saved
ordinary mixes. An arrangement has its own identity and revisions; saving it
does not overwrite either source mix.

Each side shows the title and revision it captured. Later changes to a source
mix do not change this arrangement. **Use latest saved revision** explicitly
replaces a capture. Loading a side keeps the accepted audio playing; a failed
or cancelled load keeps the previous capture. You can save and listen with one
side prepared while choosing the other. Blending and export require both sides.

## Manual blend

Press **Start listening** and move **Crossfader** toward A or B. The range control
also supports keyboard arrows, Home, and End. The percentages show each side's
contribution. It uses a linear curve: the two weights add to one, so placing the
same aligned recording on both sides does not add a midpoint boost. Different
recordings can sound quieter at the middle; adjust the source levels or the
arrangement master volume to suit the mix.

Saving a manual arrangement keeps its constant blend. It does not record the
history of slider movements.

## Timed transition

Choose a duration from 0.1 to 3,600 seconds, then press **Transition to B**. The
starting duration is 30 seconds. The transition begins from the current blend
at the shared playhead, reaches B, and stays there. The saved recipe includes
that starting blend, the wait before the move, and its duration. The text below
the controls describes what Restart and export will play.

**Cancel transition** holds the actual current blend. Moving the crossfader
also ends the timed automation and holds the newly chosen blend. Either action
switches the saved recipe to a constant manual blend; earlier movements are not
recorded.

**Pause** holds both mixes and the fade position; **Start listening** resumes.
**Stop** resets the playhead. **Restart arrangement** begins the saved recipe
at zero, including any saved wait before a timed fade.
If both mixes finish before the timed move does, their sound stops at their own
endpoints while the crossfader completes. The finished arrangement keeps its
final position; starting again replays it from zero.

## What follows the playhead

Both sides begin at their own position zero and follow one shared playhead.
A side chosen during playback joins that current position. Restart to hear its
beginning. There is no separate cue/seek control or automatic playlist.

Each captured mix retains its own layers, solo/mute choices, levels, stereo
positions, EQ, loops, movement, occasional seed, limiter, and listening timer.
The clocks keep advancing even when a side's blend weight is zero. A recording
or timed mix that has ended contributes silence. Shared audio bytes may be
cached, but both sides keep independent audible processing and layer controls.

The arrangement has a separate master volume and a combined output meter and
peak limiter. New arrangements start at 100% master volume with the final
limiter enabled at -1 dBFS; the captured mixes retain their own volume settings.

## Save, copy, and export

Use **Save arrangement**, **Save a copy**, and the saved-session selector.
Reopening or copying keeps the exact captured source revisions and declarations,
even after the originals are edited. Revision conflicts preserve the current
draft so it can be reloaded or saved as a copy.

Save the arrangement and choose a finite duration under **Export mix**. A manual
export renders its constant blend. A timed export renders the saved starting
blend, wait, and linear move to B. Each side keeps its own saved timer endpoint;
the requested WAV length only crops or pads the combined result. No additional
ending fade is inserted at that crop. The downloadable recipe and sound credits
include both captures and all their recording declarations.

Exports process the sides in floating point and apply the final limiter before
one conversion to stereo PCM16. Saving or rendering an arrangement does not
modify the source mixes or recordings. See [finished mixes](exports.md) for
download, cancellation, and source-permission behavior.
