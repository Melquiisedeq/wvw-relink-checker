'use strict';
// ---------------------------------------------------------------------
// Copyable summary
// Turning a finished run into the in-game chat block and the Discord
// block, including the 199-character chat line wrapping.
// ---------------------------------------------------------------------

function parseGuildNames(rawText) {
  const seen = new Set();
  const names = [];

  for (const line of rawText.split('\n')) {
    const trimmed = line.trim().slice(0, MAX_NAME_LENGTH);
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue; // silently de-dupe repeated entries
    seen.add(key);
    names.push(trimmed);
  }

  return names.slice(0, MAX_ENTRIES);
}

// "[TAG] " for each entry that has one, space-separated. Used for the
// compact chat version, where only tags matter, not full names.
function formatTagRow(entries) {
  return entries.filter((e) => e.tag).map((e) => `[${e.tag}]`).join(' ');
}

// The game truncates anything past 199 characters in a single chat
// message, and a populated NA server's tag row blows past that on its
// own. Each line of the chat block is pasted as one message, so every
// line has to fit on its own.
const CHAT_LINE_LIMIT = 199;

// Breaks on spaces so a tag never gets cut in half. A single token longer
// than the limit can't be helped, so it goes out alone and the game
// truncates that one.
function wrapChatLine(line) {
  if (line.length <= CHAT_LINE_LIMIT) return [line];

  const out = [];
  let current = '';
  for (const word of line.split(' ')) {
    if (word.length > CHAT_LINE_LIMIT) {
      if (current) { out.push(current); current = ''; }
      out.push(word);
    } else if (!current) {
      current = word;
    } else if (current.length + 1 + word.length <= CHAT_LINE_LIMIT) {
      current += ` ${word}`;
    } else {
      out.push(current);
      current = word;
    }
  }
  if (current) out.push(current);
  return out;
}

function wrapChatBlock(text) {
  return text.split('\n').flatMap(wrapChatLine).join('\n');
}

function buildCompactCommunityBlock(label, data) {
  if (!data) return null;
  const lines = [];
  if (data.alliances.length) lines.push(`Alliances: ${formatTagRow(data.alliances)}`);
  if (data.solo.length) lines.push(`Solo: ${formatTagRow(data.solo)}`);
  if (lines.length === 0) return null;
  return `${label}\n${lines.join('\n')}`;
}

// Discord version has room to spell things out, including each alliance
// member's own tag, since a guild doesn't always fly its alliance's tag.
function buildDetailedCommunityBlock(label, data) {
  if (!data) return null;
  const lines = [];
  if (data.alliances.length) {
    lines.push('Alliances:');
    for (const alliance of data.alliances) {
      const head = alliance.tag ? `[${alliance.tag}] ${alliance.name}` : alliance.name;
      lines.push(`  ${head}`);
      for (const member of alliance.members) {
        lines.push(`    ${member.tag ? `[${member.tag}] ${member.name}` : member.name}`);
      }
    }
  }
  if (data.solo.length) {
    lines.push('Solo guilds:');
    for (const solo of data.solo) {
      lines.push(`  ${solo.tag ? `[${solo.tag}] ${solo.name}` : solo.name}`);
    }
  }
  if (lines.length === 0) return null;
  return `${label}\n${lines.join('\n')}`;
}

// Builds a compact summary for in-game chat (tags only) and a fuller
// one for Discord (names + alliance tags). Ally/enemy data comes from
// the community sheet, so EU falls back to a plain "Fighting: ..." line.
async function buildSummaryText(entries) {
  const byTeam = new Map(); // teamId -> guild names
  for (const { name, teamId } of entries) {
    if (!byTeam.has(teamId)) byTeam.set(teamId, []);
    byTeam.get(teamId).push(name);
  }

  // Only fetched if an NA team is actually involved, and only once.
  let communityByServer = null;

  const compactBlocks = [];
  const detailedBlocks = [];

  for (const [teamId, names] of byTeam) {
    const server = getTeamName(teamId);
    const matchId = teamToMatchId.get(teamId);
    const match = matchId ? matchDataCache.get(matchId) : null;

    if (!match) {
      const line = `${names.join(', ')} landed on ${server}`;
      compactBlocks.push(line);
      detailedBlocks.push(line);
      continue;
    }

    // A week that has ended says nothing about the tier anyone is in now
    // or who they are fighting, so both drop out of the block until the
    // new one is published - measured during the relink of 26/09, five
    // of the twelve NA teams had nothing but a finished week behind them
    // for the best part of an hour.
    //
    // Two things survive it. The team, because that comes from
    // wvw/guilds and turns over with the relink, and it is the answer
    // anyone pasting this actually wants. And the community sheet, which
    // is edited by hand and has no idea a reset happened.
    const live = matchIsLive(match);
    const [regionCode, tierNum] = match.id.split('-');
    const regionName = REGION_NAMES[regionCode] || `Region ${regionCode}`;
    const myColor = colorForTeam(match, teamId);
    const enemyTeams = !live ? [] : COLORS.filter((c) => c !== myColor).map((c) => {
      const enemyTeamId = matchTeamId(match, c);
      return { teamId: enemyTeamId, name: getTeamName(enemyTeamId) };
    });

    // Both shapes were already here: the one with the tier, and the bare
    // one the branch above uses when there is no match at all.
    const header = live
      ? `${names.join(', ')} landed on ${server} (${regionName} Tier ${tierNum})`
      : `${names.join(', ')} landed on ${server}`;
    let compact = header;
    let detailed = header;

    if (regionCode === '1') {
      if (!communityByServer) {
        try { communityByServer = await loadCommunityGuilds(); } catch { communityByServer = new Map(); }
      }
      const servers = [
        { label: `${server} Allies`, name: server },
        ...enemyTeams.map((e) => ({ label: `${e.name} Enemies`, name: e.name }))
      ];
      for (const s of servers) {
        const data = communityByServer.get(s.name);
        const c = buildCompactCommunityBlock(s.label, data);
        if (c) compact += `\n\n${c}`;
        const d = buildDetailedCommunityBlock(s.label, data);
        if (d) detailed += `\n\n${d}`;
      }
    } else if (enemyTeams.length > 0) {
      const fighting = `\nFighting: ${enemyTeams.map((e) => e.name).join(', ')}`;
      compact += fighting;
      detailed += fighting;
    }

    compactBlocks.push(compact);
    detailedBlocks.push(detailed);
  }

  // Only the chat version gets wrapped; Discord has no such limit and the
  // detailed block is easier to read with its lines left intact.
  return {
    compact: wrapChatBlock(compactBlocks.join('\n\n')),
    detailed: detailedBlocks.join('\n\n')
  };
}
