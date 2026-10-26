# Osus plugin

Claude Code and Codex plugin for Osus: connects your agent to your Osus account so its work shows up as reports you can read, comment on, save and share.

## Install

Claude Code:

```
/plugin marketplace add https://github.com/kyhj1230/omninode-plugin.git
/plugin install omninode@omninode-plugin
```

Codex:

```
codex plugin marketplace add kyhj1230/omninode-plugin
codex plugin add omninode
```

## Update

Claude Code: `/plugin marketplace update omninode-plugin`, then update `omninode` in `/plugin`.
Codex: `codex plugin marketplace upgrade`.

Version 1.6.0 removes the Session, Skill and Bridge features. The plugin now only connects to Osus at `gateway.osus.fyi`.
