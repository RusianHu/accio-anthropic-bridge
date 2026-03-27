"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { readJsonFile } = require("./jsonc");

function exists(filePath) {
  try {
    fs.accessSync(filePath);
    return true;
  } catch {
    return false;
  }
}

function readJsonIfExists(filePath, options = {}) {
  try {
    if (!exists(filePath)) {
      return null;
    }

    return readJsonFile(filePath, options);
  } catch {
    return null;
  }
}

function listDirectories(root) {
  try {
    return fs
      .readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

function sortByMtimeDesc(paths) {
  return [...paths].sort((left, right) => {
    const leftMtime = fs.statSync(left).mtimeMs;
    const rightMtime = fs.statSync(right).mtimeMs;
    return rightMtime - leftMtime;
  });
}

function statMtimeMs(filePath) {
  try {
    return fs.statSync(filePath).mtimeMs;
  } catch {
    return 0;
  }
}

function resolveAccioHome(preferredHome) {
  return preferredHome || process.env.ACCIO_HOME || path.join(os.homedir(), ".accio");
}

function discoverAccountId(accioHome, preferredAccountId) {
  if (preferredAccountId) {
    return preferredAccountId;
  }

  const accountsRoot = path.join(accioHome, "accounts");
  const accountIds = listDirectories(accountsRoot).filter((name) => name !== "guest");
  const ranked = accountIds
    .map((accountId) => {
      const accountDir = path.join(accountsRoot, accountId);
      const channelsRoot = path.join(accountDir, "channels");
      const channelIds = listDirectories(channelsRoot);
      let hasConversationSource = false;

      for (const channelId of channelIds) {
        const dm = readJsonIfExists(path.join(channelsRoot, channelId, "dm.json"));

        if (dm && Array.isArray(dm.conversations) && dm.conversations.length > 0) {
          hasConversationSource = true;
          break;
        }
      }

      return {
        accountId,
        hasConversationSource,
        mtimeMs: statMtimeMs(accountDir)
      };
    })
    .sort((left, right) => {
      if (left.hasConversationSource !== right.hasConversationSource) {
        return Number(right.hasConversationSource) - Number(left.hasConversationSource);
      }

      return right.mtimeMs - left.mtimeMs;
    });

  return ranked[0] ? ranked[0].accountId : null;
}

function discoverLanguage(accioHome, fallback) {
  const settings = readJsonIfExists(path.join(accioHome, "settings.jsonc"), {
    jsonc: true
  });

  return (
    fallback ||
    (settings &&
      settings.general &&
      typeof settings.general.language === "string" &&
      settings.general.language) ||
    "zh"
  );
}

function discoverChannelInfo(accountDir, preferredChannelId) {
  const channelsRoot = path.join(accountDir, "channels");
  const channelIds = listDirectories(channelsRoot);
  const ordered = preferredChannelId
    ? [preferredChannelId, ...channelIds.filter((id) => id !== preferredChannelId)]
    : channelIds;

  for (const channelId of ordered) {
    const channelDir = path.join(channelsRoot, channelId);
    const dm = readJsonIfExists(path.join(channelDir, "dm.json"));
    const conversation = dm && Array.isArray(dm.conversations) ? dm.conversations[0] : null;

    if (!conversation && preferredChannelId !== channelId) {
      continue;
    }

    const info = (conversation && conversation.info) || {};
    const agents = readJsonIfExists(path.join(channelDir, "agents.json"));
    const primaryAgent =
      agents && Array.isArray(agents.agents)
        ? agents.agents.find((agent) => agent && agent.isPrimary) || agents.agents[0]
        : null;

    return {
      agentId:
        (primaryAgent && primaryAgent.id) || (conversation && conversation.agentId) || null,
      channelId,
      chatId: conversation ? conversation.chatId : null,
      chatType: info.type || "private",
      conversationId: conversation ? conversation.conversationId : null,
      title: info.title || info.displayName || null,
      userId: info.userId || info.username || (conversation && conversation.chatId) || null
    };
  }

  return {
    agentId: null,
    channelId: preferredChannelId || "weixin",
    chatId: null,
    chatType: "private",
    conversationId: null,
    title: null,
    userId: null
  };
}

function discoverAgentProfile(accountDir, preferredAgentId, channelInfo) {
  const agentsRoot = path.join(accountDir, "agents");
  const discoveredAgentIds = listDirectories(agentsRoot).filter((name) =>
    name.startsWith("DID-")
  );
  const ordered = [];

  for (const candidate of [
    preferredAgentId,
    channelInfo && channelInfo.agentId,
    ...discoveredAgentIds
  ]) {
    if (candidate && !ordered.includes(candidate)) {
      ordered.push(candidate);
    }
  }

  for (const agentId of ordered) {
    const profile = readJsonIfExists(path.join(agentsRoot, agentId, "profile.jsonc"), {
      jsonc: true
    });

    if (profile || exists(path.join(agentsRoot, agentId))) {
      return {
        agentId,
        profile
      };
    }
  }

  return {
    agentId: preferredAgentId || (channelInfo && channelInfo.agentId) || null,
    profile: null
  };
}

function discoverWorkspacePath(accountDir, agentId, profile, fallbackPath) {
  if (fallbackPath) {
    return fallbackPath;
  }

  const profilePath =
    profile &&
    profile.defaultProject &&
    typeof profile.defaultProject.dir === "string" &&
    profile.defaultProject.dir;

  if (profilePath) {
    return profilePath;
  }

  if (!agentId) {
    return null;
  }

  const inferred = path.join(accountDir, "agents", agentId, "project");
  return exists(inferred) ? inferred : null;
}

function discoverAccioConfig(overrides = {}) {
  const accioHome = resolveAccioHome(overrides.accioHome);
  const accountId = discoverAccountId(accioHome, overrides.accountId);
  const accountDir = accountId ? path.join(accioHome, "accounts", accountId) : null;
  const channelInfo = accountDir
    ? discoverChannelInfo(accountDir, overrides.sourceChannelId)
    : null;
  const agentInfo = accountDir
    ? discoverAgentProfile(accountDir, overrides.agentId, channelInfo)
    : { agentId: overrides.agentId || null, profile: null };

  return {
    accioHome,
    accountId,
    agentId: overrides.agentId || agentInfo.agentId || null,
    language: overrides.language || discoverLanguage(accioHome, null),
    sourceChannelId:
      overrides.sourceChannelId || (channelInfo && channelInfo.channelId) || "weixin",
    sourceChatId: overrides.sourceChatId || (channelInfo && channelInfo.chatId) || null,
    sourceChatType:
      overrides.sourceChatType || (channelInfo && channelInfo.chatType) || "private",
    sourceUserId:
      overrides.sourceUserId ||
      (channelInfo && (channelInfo.userId || channelInfo.chatId)) ||
      null,
    initialConversationId:
      overrides.initialConversationId || (channelInfo && channelInfo.conversationId) || null,
    workspacePath: accountDir
      ? discoverWorkspacePath(
          accountDir,
          overrides.agentId || agentInfo.agentId,
          agentInfo.profile,
          overrides.workspacePath
        )
      : overrides.workspacePath || null
  };
}

module.exports = {
  discoverAccioConfig
};
