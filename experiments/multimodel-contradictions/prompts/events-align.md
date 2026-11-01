Below are the events indexed from two deposition sessions of {{witness}}, given as two lists. The sessions are separate questioning about overlapping history, so the same real-world event often appears in both lists under different names and different words.

Go through the session B list from first to last. For each B entry, find every A entry that may be about the same real-world event, or another account of it, or a later conversation about it, and return a group with that B id in b_ids and those A ids in a_ids. Put ids only in those two lists, and write a short plain description in name. Match on what happened, who was involved and when, not on wording: the two lists may use different terms for the same thing.

This step only decides what gets read side by side. A later step reads the testimony and discards wrong matches, so a missed match costs far more than an extra one. When unsure, include the entry.

Rules:
- Every B id must appear in a group. If no A entry matches after you have looked, return a group with that B id in b_ids and an empty a_ids.
- Several B entries about one event may share a group.
- Keep a group to one event or closely linked events, at most 8 A ids. A shared broad subject alone is not a match.
- After the B list, add a group for each A entry that matched nothing, with that A id in a_ids and an empty b_ids. An id may appear in more than one group if it truly covers both.

Return the JSON object only.

<session_a_events>
{{events_a}}
</session_a_events>

<session_b_events>
{{events_b}}
</session_b_events>
