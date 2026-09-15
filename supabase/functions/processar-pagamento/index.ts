const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const PLANOS = {
  fatality: { nome: "FATALITY", preco: "59.90" },
  brutality: { nome: "BRUTALITY", preco: "159.90" },
} as const;

type PlanoId = keyof typeof PLANOS;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Método não permitido." }, 405);

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return json({ error: "Usuário não autenticado." }, 401);
    }

    const accessToken = authHeader.replace("Bearer ", "");
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const publishableKeysRaw = Deno.env.get("SUPABASE_PUBLISHABLE_KEYS");
    const mpAccessToken = Deno.env.get("MP_ACCESS_TOKEN");

    if (!supabaseUrl || !publishableKeysRaw || !mpAccessToken) {
      throw new Error("Variáveis obrigatórias não configuradas na Edge Function.");
    }

    const publishableKeys = JSON.parse(publishableKeysRaw);
    const supabasePublishableKey = publishableKeys.default;

    if (!supabasePublishableKey) {
      throw new Error("Não foi possível obter a chave publicável do Supabase.");
    }

    const userResponse = await fetch(`${supabaseUrl}/auth/v1/user`, {
      headers: {
        apikey: supabasePublishableKey,
        Authorization: `Bearer ${accessToken}`,
      },
    });

    if (!userResponse.ok) return json({ error: "Sessão inválida ou expirada." }, 401);

    const user = await userResponse.json();
    if (!user?.id || !user?.email) return json({ error: "Não foi possível identificar o usuário." }, 401);

    const body = await req.json().catch(() => null);
    const plano = body?.plano as PlanoId | undefined;
    const formData = body?.formData ?? {};
    const selectedPaymentMethod = body?.selectedPaymentMethod ?? null;

    if (!plano || !(plano in PLANOS)) return json({ error: "Plano inválido." }, 400);

    const produto = PLANOS[plano];
    const paymentMethodId = String(formData.payment_method_id || "");

    if (!paymentMethodId) return json({ error: "Método de pagamento não informado." }, 400);

    const payerEmail = String(formData?.payer?.email || user.email || "");
    const identification = formData?.payer?.identification || undefined;

    const paymentMethod: Record<string, unknown> = {
      id: paymentMethodId,
      type: paymentMethodId === "pix" ? "bank_transfer" : (selectedPaymentMethod === "debit_card" ? "debit_card" : "credit_card"),
    };

    if (paymentMethodId !== "pix") {
      const token = String(formData.token || "");
      const installments = Number(formData.installments || 1);
      const issuerId = formData.issuer_id != null ? Number(formData.issuer_id) : undefined;

      if (!token) return json({ error: "Token do cartão não foi recebido." }, 400);

      paymentMethod.token = token;
      paymentMethod.installments = installments;
      if (Number.isFinite(issuerId)) paymentMethod.issuer_id = issuerId;
    }

    const orderPayload: Record<string, unknown> = {
      type: "online",
      processing_mode: "automatic",
      total_amount: produto.preco,
      external_reference: `fs_${plano}_${crypto.randomUUID().replaceAll("-", "").slice(0, 20)}`,
      payer: {
        email: payerEmail,
        ...(identification ? { identification } : {}),
      },
      transactions: {
        payments: [
          {
            amount: produto.preco,
            payment_method: paymentMethod,
          },
        ],
      },
    };

    const mpResponse = await fetch("https://api.mercadopago.com/v1/orders", {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        Authorization: `Bearer ${mpAccessToken}`,
        "X-Idempotency-Key": crypto.randomUUID(),
      },
      body: JSON.stringify(orderPayload),
    });

    const mpData = await mpResponse.json();

    if (!mpResponse.ok) {
      console.error("Mercado Pago respondeu com erro:", JSON.stringify(mpData));
      return json({ error: "O Mercado Pago recusou o pagamento.", details: mpData }, 502);
    }

    const payment = mpData?.transactions?.payments?.[0];
    const paymentMethodResponse = payment?.payment_method;

    return json({
      success: true,
      order_id: mpData.id,
      order_status: mpData.status,
      payment_status: payment?.status,
      payment_status_detail: payment?.status_detail,
      message: payment?.status === "processed" ? "Pagamento aprovado." : "Pagamento enviado. Aguarde a confirmação.",
      pix: paymentMethodId === "pix" ? {
        qr_code: paymentMethodResponse?.qr_code || null,
        qr_code_base64: paymentMethodResponse?.qr_code_base64 || null,
        ticket_url: paymentMethodResponse?.ticket_url || null,
      } : null,
    });
  } catch (error) {
    console.error("Erro em processar-pagamento:", error);
    return json({
      error: "Erro interno ao processar pagamento.",
      message: error instanceof Error ? error.message : "Erro desconhecido.",
    }, 500);
  }
});
