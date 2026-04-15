const { createClient } = require('@supabase/supabase-js')

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)
const T = process.env.TABLE_PREFIX || 'ct'

function shuffle(arr) {
  const a = [...arr]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

// Circle-method round-robin. Returns array of rounds, each a array of [id1, id2] pairs.
// null in a pair means the other team has a bye that round.
function buildRoundRobin(ids, numRounds) {
  const p = ids.length % 2 === 0 ? [...ids] : [...ids, null]
  const n = p.length
  const rounds = Math.min(numRounds, n - 1)
  const schedule = []
  for (let r = 0; r < rounds; r++) {
    const pairs = []
    pairs.push([p[0], p[1 + (r % (n - 1))]])
    for (let i = 1; i < n / 2; i++) {
      pairs.push([p[1 + (r + i) % (n - 1)], p[1 + (r - i + (n - 1)) % (n - 1)]])
    }
    schedule.push(pairs)
  }
  return schedule
}

function computeStandings(matches, teams) {
  const stats = {}
  for (const t of teams) {
    stats[t.id] = { id: t.id, name: t.name, player1: t.player1, player2: t.player2, pool: t.pool, W: 0, L: 0, PF: 0, PA: 0, GP: 0 }
  }
  for (const m of matches) {
    if (m.is_bye || m.status !== 'complete' || !m.team1_id || !m.team2_id || m.score1 == null) continue
    const t1 = stats[m.team1_id], t2 = stats[m.team2_id]
    if (!t1 || !t2) continue
    t1.PF += m.score1; t1.PA += m.score2; t1.GP++
    t2.PF += m.score2; t2.PA += m.score1; t2.GP++
    if (m.winner_id === m.team1_id) { t1.W++; t2.L++ } else { t2.W++; t1.L++ }
  }
  const sort = arr => arr.sort((a, b) => b.W - a.W || (b.PF - b.PA) - (a.PF - a.PA) || b.PF - a.PF)
  return {
    A: sort(Object.values(stats).filter(s => s.pool === 'A')),
    B: sort(Object.values(stats).filter(s => s.pool === 'B'))
  }
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-password')
  if (req.method === 'OPTIONS') return res.status(200).end()

  if (req.method === 'GET') {
    const [matchRes, teamRes] = await Promise.all([
      supabase
        .from(`${T}_matches`)
        .select('*, team1:team1_id(id,name,player1,player2), team2:team2_id(id,name,player1,player2)')
        .order('bracket').order('round').order('position'),
      supabase.from(`${T}_teams`).select('*')
    ])
    if (matchRes.error) return res.status(500).json({ error: matchRes.error.message })
    const matches = matchRes.data || []
    const teams = teamRes.data || []
    return res.json({ matches, standings: computeStandings(matches, teams) })
  }

  if (req.headers['x-admin-password'] !== process.env.ADMIN_PASSWORD)
    return res.status(401).json({ error: 'Unauthorized' })

  if (req.method === 'POST') {
    const numRounds = parseInt(req.body?.rounds ?? 6)
    if (isNaN(numRounds) || numRounds < 1 || numRounds > 13)
      return res.status(400).json({ error: 'rounds must be between 1 and 13.' })

    const { data: teams, error: te } = await supabase
      .from(`${T}_teams`).select('*').order('registered_at')
    if (te) return res.status(500).json({ error: te.message })
    if (teams.length < 4) return res.status(400).json({ error: 'Need at least 4 teams.' })

    // Clear any existing matches
    await supabase.from(`${T}_matches`).delete().gte('id', 0)

    // Shuffle and split into two pools
    const shuffled = shuffle(teams)
    const half = Math.ceil(shuffled.length / 2)
    const poolA = shuffled.slice(0, half)
    const poolB = shuffled.slice(half)

    // Stamp each team with their pool
    await supabase.from(`${T}_teams`).update({ pool: 'A' }).in('id', poolA.map(t => t.id))
    await supabase.from(`${T}_teams`).update({ pool: 'B' }).in('id', poolB.map(t => t.id))

    const allMatches = []
    let pos = 0

    const addPoolMatches = (ids, pool) => {
      buildRoundRobin(ids, numRounds).forEach((roundPairs, rIdx) => {
        roundPairs.forEach(([t1, t2]) => {
          const isBye = t1 === null || t2 === null
          allMatches.push({
            bracket: pool,
            round: rIdx + 1,
            position: pos++,
            team1_id: isBye ? (t1 ?? t2) : t1,
            team2_id: isBye ? null : t2,
            score1: null,
            score2: null,
            winner_id: isBye ? (t1 ?? t2) : null,
            next_match_id: null,
            next_slot: null,
            loser_next_match_id: null,
            loser_next_slot: null,
            status: isBye ? 'complete' : 'pending',
            is_bye: isBye
          })
        })
      })
    }

    addPoolMatches(poolA.map(t => t.id), 'A')
    addPoolMatches(poolB.map(t => t.id), 'B')

    const { error: ie } = await supabase.from(`${T}_matches`).insert(allMatches)
    if (ie) return res.status(500).json({ error: ie.message })

    await supabase.from(`${T}_settings`).upsert({ key: 'bracket_created', value: 'true' })
    await supabase.from(`${T}_settings`).upsert({ key: 'tournament_format', value: 'pool_play' })

    return res.json({
      success: true,
      matchCount: allMatches.length,
      poolA: poolA.length,
      poolB: poolB.length,
      rounds: numRounds
    })
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
      return res.status(400).json({ error: 'Bye matches cannot be scored.' })

    const winner_id = score1 > score2 ? match.team1_id : match.team2_id
    const { error } = await supabase.from(`${T}_matches`)
      .update({ score1, score2, winner_id, status: 'complete' })
      .eq('id', match_id)
    if (error) return res.status(500).json({ error: error.message })
    return res.json({ success: true })
  }

  if (req.method === 'DELETE') {
    await supabase.from(`${T}_matches`).delete().gte('id', 0)
    await supabase.from(`${T}_teams`).update({ pool: null }).in('pool', ['A', 'B'])
    await supabase.from(`${T}_settings`).upsert({ key: 'bracket_created', value: 'false' })
    await supabase.from(`${T}_settings`).upsert({ key: 'tournament_format', value: 'bracket' })
    return res.json({ success: true })
  }

  res.status(405).json({ error: 'Method not allowed' })
}
