const { createClient } = require('@supabase/supabase-js')

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)
const T = process.env.TABLE_PREFIX || 'ct'

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, PUT, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  if (req.method === 'OPTIONS') return res.status(200).end()

  // GET ?t=TOKEN — load match details for the score page
  if (req.method === 'GET') {
    const { t } = req.query
    if (!t) return res.status(400).json({ error: 'Token required.' })

    const { data: match, error } = await supabase
      .from(`${T}_matches`)
      .select('*, team1:team1_id(id,name,player1,player2), team2:team2_id(id,name,player1,player2)')
      .eq('token', t)
      .single()

    if (error || !match) return res.status(404).json({ error: 'Match not found. Check your text message for the correct link.' })

    const format = (match.bracket === 'A' || match.bracket === 'B') ? 'pool_play' : 'bracket'
    return res.json({ match, format })
  }

  // PUT { token, score1, score2 } — submit score
  if (req.method === 'PUT') {
    const { token, score1, score2 } = req.body || {}
    if (!token || score1 == null || score2 == null)
      return res.status(400).json({ error: 'token, score1, and score2 are required.' })
    if (score1 === score2)
      return res.status(400).json({ error: 'Scores cannot be tied.' })
    if (score1 < 0 || score2 < 0)
      return res.status(400).json({ error: 'Scores must be 0 or higher.' })

    const { data: match, error: me } = await supabase
      .from(`${T}_matches`).select('*').eq('token', token).single()

    if (me || !match) return res.status(404).json({ error: 'Match not found.' })
    if (!match.team1_id || !match.team2_id)
      return res.status(400).json({ error: 'This is a bye round — no score needed.' })
    if (match.status === 'complete')
      return res.status(400).json({ error: 'Score already recorded. Contact your admin to make a change.' })

    const winner_id = score1 > score2 ? match.team1_id : match.team2_id
    const loser_id  = score1 > score2 ? match.team2_id : match.team1_id

    const { error } = await supabase.from(`${T}_matches`)
      .update({ score1, score2, winner_id, status: 'complete' })
      .eq('id', match.id)
    if (error) return res.status(500).json({ error: error.message })

    // For bracket matches, propagate winner and loser to next matches
    const isBracket = match.bracket === 'W' || match.bracket === 'L'
    if (isBracket) {
      if (match.next_match_id && winner_id) {
        const slot = match.next_slot === 1 ? 'team1_id' : 'team2_id'
        await supabase.from(`${T}_matches`).update({ [slot]: winner_id }).eq('id', match.next_match_id)
      }
      if (match.bracket === 'W' && match.loser_next_match_id && loser_id) {
        const { data: priorWins } = await supabase
          .from(`${T}_matches`).select('id').eq('winner_id', loser_id).eq('is_bye', false)
        if (!priorWins?.length) {
          const slot = match.loser_next_slot === 1 ? 'team1_id' : 'team2_id'
          await supabase.from(`${T}_matches`).update({ [slot]: loser_id }).eq('id', match.loser_next_match_id)
        }
      }
    }

    return res.json({ success: true })
  }

  res.status(405).json({ error: 'Method not allowed' })
}
