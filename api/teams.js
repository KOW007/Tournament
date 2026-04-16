const { createClient } = require('@supabase/supabase-js')

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
)

const T = process.env.TABLE_PREFIX || 'ct'

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-password')
  if (req.method === 'OPTIONS') return res.status(200).end()

  if (req.method === 'GET') {
    const { data, error } = await supabase
      .from(`${T}_teams`)
      .select('*')
      .order('registered_at', { ascending: true })
    if (error) return res.status(500).json({ error: error.message })
    return res.json(data)
  }

  if (req.method === 'POST') {
    const { data: setting } = await supabase
      .from(`${T}_settings`).select('value').eq('key', 'bracket_created').single()
    if (setting?.value === 'true')
      return res.status(400).json({ error: 'Registration is closed — bracket has been created.' })

    const { name, player1, player2, phone, partner_status, shirt1, shirt2 } = req.body
    if (!name?.trim() || !player1?.trim() || !phone?.trim())
      return res.status(400).json({ error: 'Team name, player name, and phone number are required.' })
    if (partner_status === 'has_partner' && !player2?.trim())
      return res.status(400).json({ error: 'Please enter your partner\'s name.' })
    const digits = phone.replace(/\D/g, '')
    if (digits.length !== 10 && !(digits.length === 11 && digits[0] === '1'))
      return res.status(400).json({ error: 'Please enter a valid 10-digit US phone number.' })

    const { count } = await supabase
      .from(`${T}_teams`).select('*', { count: 'exact', head: true })
    if (count >= 64)
      return res.status(400).json({ error: 'Tournament is full (64 teams max).' })

    const { data, error } = await supabase
      .from(`${T}_teams`)
      .insert([{ name: name.trim(), player1: player1.trim(), player2: player2?.trim() || null, phone: phone.trim(), partner_status: partner_status || 'has_partner', shirt1: shirt1 || null, shirt2: shirt2 || null }])
      .select().single()
    if (error) {
      if (error.code === '23505')
        return res.status(400).json({ error: 'A team with that name is already registered.' })
      return res.status(500).json({ error: error.message })
    }
    return res.status(201).json(data)
  }

  if (req.method === 'PUT') {
    // Join a team as player 2
    const { team_id, player2, phone2 } = req.body
    if (!team_id || !player2?.trim() || !phone2?.trim())
      return res.status(400).json({ error: 'Name and phone are required.' })

    const { data: team } = await supabase.from(`${T}_teams`).select('*').eq('id', team_id).single()
    if (!team) return res.status(404).json({ error: 'Team not found.' })
    if (team.partner_status !== 'need_partner')
      return res.status(400).json({ error: 'This team is no longer looking for a partner.' })

    const { error } = await supabase.from(`${T}_teams`)
      .update({ player2: player2.trim(), partner_status: 'has_partner' })
      .eq('id', team_id)
    if (error) return res.status(500).json({ error: error.message })
    return res.json({ success: true })
  }

  if (req.method === 'PATCH') {
    if (req.headers['x-admin-password'] !== process.env.ADMIN_PASSWORD)
      return res.status(401).json({ error: 'Unauthorized' })
    const { id } = req.query
    const { paid1, paid2 } = req.body
    if (!id) return res.status(400).json({ error: 'Team ID required' })
    const update = {}
    if (paid1 !== undefined) update.paid1 = paid1
    if (paid2 !== undefined) update.paid2 = paid2
    const { error } = await supabase.from(`${T}_teams`).update(update).eq('id', id)
    if (error) return res.status(500).json({ error: error.message })
    return res.json({ success: true })
  }

  if (req.method === 'DELETE') {
    if (req.headers['x-admin-password'] !== process.env.ADMIN_PASSWORD)
      return res.status(401).json({ error: 'Unauthorized' })
    const { id } = req.query
    if (!id) return res.status(400).json({ error: 'Team ID required' })
    const { error } = await supabase.from(`${T}_teams`).delete().eq('id', id)
    if (error) return res.status(500).json({ error: error.message })
    return res.json({ success: true })
  }

  res.status(405).json({ error: 'Method not allowed' })
}
