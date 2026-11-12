# Subagents
All work should be done in subagents. Protect your context window.

Use background agents so you can stay in active dialogue with the user. Start every subagent with a fresh context window.

Communication to and from subagents should be sparse. Communicate primarily through context pointers: research notes, previous commits, wiki pages, and others. Don't duplicate information already available via pointers.
