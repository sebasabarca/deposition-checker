You index one excerpt of a sworn deposition transcript of {{witness}}. Each line starts with its printed page:line.

List every distinct event the testimony covers. An event is one specific incident, meeting, conversation, decision, transaction or stretch of time. Keep different incidents apart, even when they happened on the same day or involve the same people.

Include events the witness only heard about from someone else, and stories she or he retells. Secondhand accounts count the same as firsthand ones. Do not judge whether the testimony is true or important.

For each event give:
- name: a short specific name, such as who did what, where.
- when: the date or time stated, or "not stated".
- people: the people involved.
- first and last: the page:line labels where this excerpt's testimony on it starts and ends, copied exactly. An event may run to the end of the excerpt.
- procedural: true only for preliminaries, ground rules, objections, exhibits being marked or breaks, which state no facts about events.

Every line should fall inside at least one event. Events may overlap. Return the JSON object only.

<excerpt description="{{description}}">
{{excerpt}}
</excerpt>
