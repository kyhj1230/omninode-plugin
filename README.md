# Omninode plugin

Claude Code and Codex plugin for Omninode: save and read Sessions, save and install Skills, and ask the other agent a question through the local Bridge.

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

Session and Skill saving needs the Omninode Connector connected to your account. Bridge needs the Codex and Claude Code CLIs installed and signed in.
