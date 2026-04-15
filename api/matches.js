const { createClient } = require('@supabase/supabase-js')

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
)

const T = process.env.TABLE_PREFIX || 'ct'

function getBracketSize(teamCount) {
  const sizes = [8, 16, 32, 64, 128]
  return sizes.find(s => s >= teamCount) || 128
}

function buildMatchStructure(bracketSize) {
  const matches = []
  let id = 1

  const WB_ROUNDS = Math.log2(bracketSize)
  // Consolation is single elimination — narrows every round.
  // WB R1 losers seed consolation R1. Consolation slots freed by R1 byes are
  // claimed by WB R2 bye-recipients who lose (their first real loss). See assignTeams.
  const LB_ROUNDS = WB_ROUNDS - 1

  // Pre-assign IDs for WB
  const wb = {}
  for (let r = 1; r <= WB_ROUNDS; r++) {
    wb[r] = {}
    const count = bracketSize / Math.pow(2, r)
    for (let p = 0; p < count; p++) wb[r][p] = id++
  }

  // Pre-assign IDs for LB (single elimination, halves each round)
  // LB Rr has bracketSize / 2^(r+1) matches
  const lb = {}
  for (let r = 1; r <= LB_ROUNDS; r++) {
    lb[r] = {}
    const count = bracketSize / Math.pow(2, r + 1)
    for (let p = 0; p < count; p++) lb[r][p] = id++
  }

  // Generate WB matches
  for (let r = 1; r <= WB_ROUNDS; r++) {
    const count = bracketSize / Math.pow(2, r)
    for (let p = 0; p < count; p++) {
      const next_match_id = r < WB_ROUNDS ? wb[r + 1][Math.floor(p / 2)] : null
      const next_slot = r < WB_ROUNDS ? (p % 2) + 1 : null

      // WB R1 losers → consolation R1. WB R2 loser routing set in assignTeams.
      let loser_next_match_id = null, loser_next_slot = null
      if (r === 1 && LB_ROUNDS > 0) {
        loser_next_match_id = lb[1][Math.floor(p / 2)]
        loser_next_slot = (p % 2) + 1
      }

      matches.push({
        id: wb[r][p], bracket: 'W', round: r, position: p,
        team1_id: null, team2_id: null, score1: null, score2: null, winner_id: null,
        next_match_id, next_slot, loser_next_match_id, loser_next_slot,
        status: 'pending', is_bye: false
      })
    }
  }

  // Generate LB matches (single elimination, halves each round)
  for (let r = 1; r <= LB_ROUNDS; r++) {
    const count = bracketSize / Math.pow(2, r + 1)
    for (let p = 0; p < count; p++) {
      const next_match_id = r < LB_ROUNDS ? lb[r + 1][Math.floor(p / 2)] : null
      const next_slot = r < LB_ROUNDS ? (p % 2) + 1 : null
      matches.push({
        id: lb[r][p], bracket: 'L', round: r, position: p,
        team1_id: null, team2_id: null, score1: null, score2: null, winner_id: null,
        next_match_id, next_slot, loser_next_match_id: null, loser_next_slot: null,
        status: 'pending', is_bye: false
      })
    }
  }

  return matches
}

function assignTeams(matches, teams, bracketSize) {
  const shuffled = [...teams]
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]
  }

  const numMatches = bracketSize / 2
  const numRealVsReal = Math.max(0, teams.length - numMatches)

  // Spread real-vs-real matches evenly across R1 positions
  const realPositions = new Set()
  for (let i = 0; i < numRealVsReal; i++) {
    realPositions.add(Math.round(i * numMatches / numRealVsReal))
  }

  const r1 = matches.filter(m => m.bracket === 'W' && m.round === 1).sort((a, b) => a.position - b.position)
  let teamIdx = 0
  r1.forEach((match, i) => {
    match.team1_id = shuffled[teamIdx++]?.id || null
    if (realPositions.has(i)) {
      match.team2_id = shuffled[teamIdx++]?.id || null
    }
    if (!match.team1_id || !match.team2_id) {
      match.is_bye = true
      match.status = 'complete'
      match.winner_id = match.team1_id || match.team2_id
    }
  })

  // Route WB R2 losers to consolation when one of their R1 feeders was a bye.
  // Each bye in R1 frees a consolation R1 slot; the corresponding R2 loser claims it.
  const r2 = matches.filter(m => m.bracket === 'W' && m.round === 2).sort((a, b) => a.position - b.position)
  r2.forEach((r2m, q) => {
    const r1a = r1[2 * q]      // feeds slot 1 of this R2 match
    const r1b = r1[2 * q + 1]  // feeds slot 2 of this R2 match
    if (r1a && r1a.is_bye) {
      // r1a's consolation slot is empty — give it to the R2 loser
      r2m.loser_next_match_id = r1a.loser_next_match_id
      r2m.loser_next_slot = r1a.loser_next_slot
    } else if (r1b && r1b.is_bye) {
      r2m.loser_next_match_id = r1b.loser_next_match_id
      r2m.loser_next_slot = r1b.loser_next_slot
    }
    // If neither R1 feeder was a bye, both teams already had a real loss — R2 loser is eliminated
  })

  // No propagation at creation — teams advance only when scores are entered
  return matches
}

async function propagateByes() {
  for (let pass = 0; pass < 20; pass++) {
    const { data: allMatches } = await supabase.from(`${T}_matches`).select('*')
    if (!allMatches) break
    const matchMap = Object.fromEntries(allMatches.map(m => [m.id, { ...m }]))
    let changed = false

    // Phase 1: fill all empty next-match slots from complete matches
    for (const m of allMatches) {
      if (m.status !== 'complete' || !m.winner_id || !m.next_match_id) continue
      const next = matchMap[m.next_match_id]
      if (!next || next.status === 'complete') continue
      const slotField = m.next_slot === 1 ? 'team1_id' : 'team2_id'
      if (!next[slotField]) {
        await supabase.from(`${T}_matches`).update({ [slotField]: m.winner_id }).eq('id', m.next_match_id)
        next[slotField] = m.winner_id
        changed = true
      }
    }

    // Phase 2: auto-complete matches whose empty slot(s) can never be filled.
    // A slot is "settled" if it already has a team OR every match that feeds into
    // that slot is already complete (so no team is coming).
    const allMaps = Object.values(matchMap)
    for (const next of allMaps) {
      if (next.status === 'complete') continue
      if (next.team1_id && next.team2_id) continue  // two real teams — needs a score

      const feedersFor = (slotNum) => allMaps.filter(f =>
        (f.next_match_id === next.id && f.next_slot === slotNum) ||
        (f.loser_next_match_id === next.id && f.loser_next_slot === slotNum)
      )

      const slot1Settled = !!next.team1_id || feedersFor(1).every(f => f.status === 'complete')
      const slot2Settled = !!next.team2_id || feedersFor(2).every(f => f.status === 'complete')

      if (slot1Settled && slot2Settled) {
        const winnerId = next.team1_id || next.team2_id || null
        await supabase.from(`${T}_matches`).update({
          winner_id: winnerId, status: 'complete', is_bye: true
        }).eq('id', next.id)
        next.winner_id = winnerId
        next.status = 'complete'
        next.is_bye = true
        changed = true
      }
    }

    if (!changed) break
  }
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-password')
  if (req.method === 'OPTIONS') return res.status(200).end()

  if (req.method === 'GET') {
    const { data, error } = await supabase
      .from(`${T}_matches`)
      .select(`*, team1:team1_id(id,name,player1,player2), team2:team2_id(id,name,player1,player2), winner:winner_id(id,name)`)
      .order('bracket').order('round').order('position')
    if (error) return res.status(500).json({ error: error.message })
    return res.json(data)
  }

  if (req.headers['x-admin-password'] !== process.env.ADMIN_PASSWORD)
    return res.status(401).json({ error: 'Unauthorized' })

  if (req.method === 'POST') {
    const { data: teams, error: te } = await supabase
      .from(`${T}_teams`).select('*').order('registered_at')
    if (te) return res.status(500).json({ error: te.message })
    if (teams.length < 2) return res.status(400).json({ error: 'Need at least 2 teams.' })

    const bracketSize = getBracketSize(teams.length)

    await supabase.from(`${T}_matches`).delete().gte('id', 0)

    let matches = buildMatchStructure(bracketSize)
    matches = assignTeams(matches, teams, bracketSize)

    const { error: ie } = await supabase.from(`${T}_matches`).insert(matches)
    if (ie) return res.status(500).json({ error: ie.message })

    await supabase.from(`${T}_settings`).upsert({ key: 'bracket_created', value: 'true' })
    return res.json({ success: true, matchCount: matches.length })
  }

  if (req.method === 'PUT') {
    const { match_id, score1, score2 } = req.body
    if (match_id == null || score1 == null || score2 == null)
      return res.status(400).json({ error: 'match_id, score1, score2 required' })
    if (score1 === score2)
      return res.status(400).json({ error: 'Scores cannot be tied.' })

    const { data: match, error: me } = await supabase
      .from(`${T}_matches`).select('*').eq('id', match_id).single()
    if (me || !match) return res.status(404).json({ error: 'Match not found' })
    if (!match.team1_id || !match.team2_id)
      return res.status(400).json({ error: 'Match does not have two teams yet.' })

    const winner_id = score1 > score2 ? match.team1_id : match.team2_id
    const loser_id = score1 > score2 ? match.team2_id : match.team1_id

    await supabase.from(`${T}_matches`)
      .update({ score1, score2, winner_id, status: 'complete' })
      .eq('id', match_id)

    if (match.next_match_id && winner_id) {
      const slot = match.next_slot === 1 ? 'team1_id' : 'team2_id'
      await supabase.from(`${T}_matches`)
        .update({ [slot]: winner_id }).eq('id', match.next_match_id)
    }

    if (match.bracket === 'W' && match.loser_next_match_id && loser_id) {
      // Only send to consolation if this is the loser's first real match loss.
      // A prior real win means they've already had their second chance (guaranteed 2 matches).
      const { data: priorWins } = await supabase
        .from(`${T}_matches`)
        .select('id')
        .eq('winner_id', loser_id)
        .eq('is_bye', false)
      const isFirstRealLoss = !priorWins || priorWins.length === 0
      if (isFirstRealLoss) {
        const slot = match.loser_next_slot === 1 ? 'team1_id' : 'team2_id'
        await supabase.from(`${T}_matches`)
          .update({ [slot]: loser_id }).eq('id', match.loser_next_match_id)
      }
    }

    // Propagate any bye wins that are now unblocked
    await propagateByes()

    return res.json({ success: true })
  }

  if (req.method === 'DELETE') {
    await supabase.from(`${T}_matches`).delete().gte('id', 0)
    await supabase.from(`${T}_settings`).upsert({ key: 'bracket_created', value: 'false' })
    return res.json({ success: true })
  }

  res.status(405).json({ error: 'Method not allowed' })
}
