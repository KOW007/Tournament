const { createClient } = require('@supabase/supabase-js')

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)
const T = process.env.TABLE_PREFIX || 'ct'

function normalizePhone(raw) {
  let p = raw.replace(/\D/g, '')
  if (p.length === 10) p = '1' + p
  return p
}

async function sendText(phone, message) {
  try {
    const r = await fetch('https://textbelt.com/text', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        phone: normalizePhone(phone),
        message,
        key: process.env.TEXTBELT_KEY || 'textbelt'
      })
    })
    const data = await r.json()
    return { ok: data.success === true, error: data.error || data.message || null, quotaRemaining: data.quotaRemaining }
  } catch (e) {
    return { ok: false, error: e.message }
  }
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-password')
  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  if (req.headers['x-admin-password'] !== process.env.ADMIN_PASSWORD)
    return res.status(401).json({ error: 'Unauthorized' })

  const { action, team_id, round } = req.body || {}

  // ── Round score links (pool play or bracket) ────────────────────────────────
  if (action === 'round') {
    if (!round) return res.status(400).json({ error: 'round is required.' })

    const baseUrl = `https://${req.headers.host}`
    const eventName = process.env.EVENT_NAME || 'Tournament'

    const { data: matches, error } = await supabase
      .from(`${T}_matches`)
      .select('*, team1:team1_id(id,name,phone), team2:team2_id(id,name,phone)')
      .eq('round', parseInt(round))
      .eq('is_bye', false)
      .order('bracket').order('position')

    if (error) return res.status(500).json({ error: error.message })
    if (!matches?.length) return res.status(400).json({ error: `No matches found for round ${round}.` })

    const results = { sent: 0, failed: 0, skipped: 0, sentList: [], failedList: [] }

    // Assign court numbers globally across both pools (Pool A first, then Pool B)
    matches.sort((a, b) => a.bracket.localeCompare(b.bracket) || a.position - b.position)
    matches.forEach((m, i) => { m._court = i + 1 })

    for (const m of matches) {
      const pool = m.bracket
      const court = m._court

      const isPoolPlay = pool === 'A' || pool === 'B'
      const link = `${baseUrl}/score?t=${m.token}`

      for (const team of [m.team1, m.team2]) {
        if (!team?.phone) { results.skipped++; continue }
        const opponent = team.id === m.team1_id ? m.team2?.name : m.team1?.name
        const locationLine = isPoolPlay
          ? `Pool ${pool} · Court ${court}`
          : `Court ${court}`
        const msg = `${eventName} – Round ${round}\n${locationLine}\nvs ${opponent}\nSubmit score: ${link}`
        const { ok, error: textErr, quotaRemaining } = await sendText(team.phone, msg)
        if (ok) { results.sent++; results.sentList.push({ name: team.name, phone: team.phone, quotaRemaining }) }
        else { results.failed++; results.failedList.push({ name: team.name, phone: team.phone, error: textErr }) }
      }
    }

    return res.json({ success: true, ...results })
  }

  // ── Championship score link ─────────────────────────────────────────────────
  if (action === 'championship') {
    const baseUrl = `https://${req.headers.host}`
    const eventName = process.env.EVENT_NAME || 'Tournament'

    const { data: champMatch, error } = await supabase
      .from(`${T}_matches`)
      .select('*, team1:team1_id(id,name,phone), team2:team2_id(id,name,phone)')
      .eq('bracket', 'F')
      .single()

    if (error || !champMatch) return res.status(400).json({ error: 'No championship match found. Create it first.' })

    const link = `${baseUrl}/score?t=${champMatch.token}`
    const results = { sent: 0, failed: 0, skipped: 0, sentList: [], failedList: [] }

    for (const team of [champMatch.team1, champMatch.team2]) {
      if (!team?.phone) { results.skipped++; continue }
      const opponent = team.id === champMatch.team1_id ? champMatch.team2?.name : champMatch.team1?.name
      const msg = `${eventName} – CHAMPIONSHIP\nvs ${opponent}\nSubmit your score: ${link}`
      const { ok, error: textErr, quotaRemaining } = await sendText(team.phone, msg)
      if (ok) { results.sent++; results.sentList.push({ name: team.name, phone: team.phone, quotaRemaining }) }
      else { results.failed++; results.failedList.push({ name: team.name, phone: team.phone, error: textErr }) }
    }
    return res.json({ success: true, ...results })
  }

  // ── Payment notification ────────────────────────────────────────────────────
  const eventName   = process.env.EVENT_NAME   || 'Tournament'
  const venmoHandle = process.env.VENMO_HANDLE || ''
  const entryFee    = parseInt(process.env.ENTRY_FEE || '0')
  const venmoLink   = venmoHandle
    ? `https://venmo.com/${venmoHandle}?txn=pay&amount=${entryFee}&note=${encodeURIComponent(eventName)}`
    : '(Venmo not configured)'
  const message = `Hi! You're registered for the ${eventName}. Entry fee is $${entryFee}/team ($${Math.round(entryFee / 2)}/person). Please pay via Venmo: ${venmoLink}`

  const { data: teams, error } = await supabase
    .from(`${T}_teams`).select('id, name, phone, partner_status')
  if (error) return res.status(500).json({ error: error.message })

  const targetTeams = team_id ? teams.filter(t => t.id === team_id) : teams
  const results = { sent: 0, failed: 0, skipped: 0, sentList: [], failedList: [] }

  for (const team of targetTeams) {
    if (!team.phone) { results.skipped++; continue }
    const { ok, error: textErr, quotaRemaining } = await sendText(team.phone, message)
    if (ok) { results.sent++; results.sentList.push({ name: team.name, phone: team.phone, quotaRemaining }) }
    else { results.failed++; results.failedList.push({ name: team.name, phone: team.phone, error: textErr }) }
  }

  return res.json({ success: true, ...results })
}
