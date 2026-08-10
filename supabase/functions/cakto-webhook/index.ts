import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

serve(async (req) => {
  try {
    // 1. Pega os dados que a Cakto acabou de enviar
    const body = await req.json()
    
    // 2. Conecta no seu Supabase com poderes de administrador invisíveis
    const supabaseClient = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    )

    // 3. Puxa as informações da venda da Cakto
    const email = body.customer?.email || body.client_email || body.email;
    const plano = body.product?.name || body.produto || 'Plano Desconhecido';
    const status = body.status || body.pagamento || 'pendente';
    const codigo = body.transaction?.id || body.transacao || body.id || 'SEM-CODIGO';

    // 4. Se a compra foi APROVADA, salva direto no banco de dados!
    if (status === 'approved' || status === 'paid' || status === 'aprovado' || status === 'completed') {
        const { error } = await supabaseClient
          .from('compras')
          .insert({
            email_cliente: email,
            plano_comprado: plano,
            status_pagamento: 'Aprovado',
            codigo_pedido: codigo
          })

        if (error) throw error;
    }

    return new Response(JSON.stringify({ message: "Missão cumprida! Venda registrada." }), {
      headers: { "Content-Type": "application/json" },
      status: 200,
    })

  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      headers: { "Content-Type": "application/json" },
      status: 400,
    })
  }
})