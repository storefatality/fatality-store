import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const PLANOS = {
  fatality: {
    nome: "FATALITY",
    preco: "59.90",
  },

  brutality: {
    nome: "BRUTALITY",
    preco: "159.90",
  },
} as const;

type PlanoId = keyof typeof PLANOS;

// ============================================================
// RESPOSTA JSON
// ============================================================

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json",
    },
  });
}

// ============================================================
// FUNÇÃO PRINCIPAL
// ============================================================

Deno.serve(async (req) => {
  // ==========================================================
  // CORS
  // ==========================================================

  if (req.method === "OPTIONS") {
    return new Response("ok", {
      headers: corsHeaders,
    });
  }

  // ==========================================================
  // SOMENTE POST
  // ==========================================================

  if (req.method !== "POST") {
    return json(
      {
        error: "Método não permitido.",
      },
      405,
    );
  }

  try {
    // ========================================================
    // 1. AUTENTICAÇÃO
    // ========================================================

    const authHeader =
      req.headers.get("Authorization");

    if (!authHeader?.startsWith("Bearer ")) {
      return json(
        {
          error: "Usuário não autenticado.",
        },
        401,
      );
    }

    const accessToken =
      authHeader.replace("Bearer ", "");

    // ========================================================
    // 2. SECRETS / CONFIGURAÇÕES
    // ========================================================

    const supabaseUrl =
      Deno.env.get("SUPABASE_URL");

    const publishableKeysRaw =
      Deno.env.get("SUPABASE_PUBLISHABLE_KEYS");

    const secretKeysRaw =
      Deno.env.get("SUPABASE_SECRET_KEYS");

    const mpAccessToken =
      Deno.env.get("MP_ACCESS_TOKEN");

    if (
      !supabaseUrl ||
      !publishableKeysRaw ||
      !secretKeysRaw ||
      !mpAccessToken
    ) {
      throw new Error(
        "Variáveis obrigatórias não configuradas na Edge Function.",
      );
    }

    // ========================================================
    // 3. CHAVE PUBLICÁVEL DO SUPABASE
    // ========================================================

    const publishableKeys =
      JSON.parse(publishableKeysRaw);

    const supabasePublishableKey =
      publishableKeys.default;

    if (!supabasePublishableKey) {
      throw new Error(
        "Não foi possível obter a chave publicável do Supabase.",
      );
    }

    // ========================================================
    // 4. CHAVE SECRETA DO SUPABASE
    // ========================================================

    const secretKeys =
      JSON.parse(secretKeysRaw);

    const supabaseSecretKey =
      secretKeys.default;

    if (!supabaseSecretKey) {
      throw new Error(
        "Não foi possível obter a chave secreta do Supabase.",
      );
    }

    // ========================================================
    // 5. VALIDAR USUÁRIO LOGADO
    // ========================================================

    const userResponse =
      await fetch(
        `${supabaseUrl}/auth/v1/user`,
        {
          method: "GET",

          headers: {
            apikey:
              supabasePublishableKey,

            Authorization:
              `Bearer ${accessToken}`,
          },
        },
      );

    if (!userResponse.ok) {
      return json(
        {
          error:
            "Sessão inválida ou expirada.",
        },
        401,
      );
    }

    const user =
      await userResponse.json();

    if (!user?.id || !user?.email) {
      return json(
        {
          error:
            "Não foi possível identificar o usuário.",
        },
        401,
      );
    }

    // ========================================================
    // 6. CLIENTE ADMINISTRATIVO DO SUPABASE
    // ========================================================

    const supabaseAdmin =
      createClient(
        supabaseUrl,
        supabaseSecretKey,
        {
          auth: {
            autoRefreshToken: false,
            persistSession: false,
          },
        },
      );

    // ========================================================
    // 7. LER DADOS DO FRONTEND
    // ========================================================

    const body =
      await req.json().catch(() => null);

    const plano =
      body?.plano as PlanoId | undefined;

    const formData =
      body?.formData ?? {};

    const selectedPaymentMethod =
      body?.selectedPaymentMethod ?? null;

    // ========================================================
    // 8. VALIDAR PLANO
    // ========================================================

    if (
      !plano ||
      !(plano in PLANOS)
    ) {
      return json(
        {
          error: "Plano inválido.",
        },
        400,
      );
    }

    // ========================================================
    // 9. PEGAR PREÇO PELO SERVIDOR
    // ========================================================

    const produto =
      PLANOS[plano];

    // ========================================================
    // 10. MÉTODO DE PAGAMENTO
    // ========================================================

    const paymentMethodId =
      String(
        formData.payment_method_id || "",
      );

    if (!paymentMethodId) {
      return json(
        {
          error:
            "Método de pagamento não informado.",
        },
        400,
      );
    }

    // ========================================================
    // 11. EMAIL DO PAGADOR
    // ========================================================

    const payerEmail =
      String(
        formData?.payer?.email ||
        user.email ||
        "",
      );

    if (!payerEmail) {
      return json(
        {
          error:
            "E-mail do pagador não informado.",
        },
        400,
      );
    }

    // ========================================================
    // 12. IDENTIFICAÇÃO
    // ========================================================

    const identification =
      formData?.payer?.identification ||
      undefined;

    // ========================================================
    // 13. MÉTODO DE PAGAMENTO
    // ========================================================

    const paymentMethod:
      Record<string, unknown> = {
        id: paymentMethodId,

        type:
          paymentMethodId === "pix"
            ? "bank_transfer"
            : selectedPaymentMethod ===
              "debit_card"
              ? "debit_card"
              : "credit_card",
      };

    // ========================================================
    // 14. DADOS DO CARTÃO
    // ========================================================

    if (
      paymentMethodId !== "pix"
    ) {
      const token =
        String(
          formData.token || "",
        );

      const installments =
        Number(
          formData.installments || 1,
        );

      const issuerId =
        formData.issuer_id != null
          ? Number(
              formData.issuer_id,
            )
          : undefined;

      if (!token) {
        return json(
          {
            error:
              "Token do cartão não foi recebido.",
          },
          400,
        );
      }

      paymentMethod.token =
        token;

      paymentMethod.installments =
        installments;

      if (
        Number.isFinite(
          issuerId,
        )
      ) {
        paymentMethod.issuer_id =
          issuerId;
      }
    }

    // ========================================================
    // 15. REFERÊNCIA CURTA
    // ========================================================

    const referenciaUnica =
      crypto
        .randomUUID()
        .replaceAll("-", "")
        .slice(0, 20);

    const externalReference =
      `fs_${plano}_${referenciaUnica}`;

    // Exemplo:
    // fs_fatality_a81c92f0e4b61d23

    // ========================================================
    // 16. CRIAR ORDER
    // ========================================================

    const orderPayload:
      Record<string, unknown> = {
        type: "online",

        processing_mode:
          "automatic",

        total_amount:
          produto.preco,

        external_reference:
          externalReference,

        description:
          `${produto.nome} - Acesso Vitalício`,

        payer: {
          email:
            payerEmail,

          ...(identification
            ? {
                identification,
              }
            : {}),
        },

        transactions: {
          payments: [
            {
              amount:
                produto.preco,

              payment_method:
                paymentMethod,
            },
          ],
        },
      };

    console.log(
      "Criando Order:",
      JSON.stringify(
        {
          plano,
          valor:
            produto.preco,
          payment_method_id:
            paymentMethodId,
          external_reference:
            externalReference,
          user_id:
            user.id,
        },
        null,
        2,
      ),
    );

    // ========================================================
    // 17. ENVIAR PARA MERCADO PAGO
    // ========================================================

    const mpResponse =
      await fetch(
        "https://api.mercadopago.com/v1/orders",
        {
          method: "POST",

          headers: {
            Accept:
              "application/json",

            "Content-Type":
              "application/json",

            Authorization:
              `Bearer ${mpAccessToken}`,

            "X-Idempotency-Key":
              crypto.randomUUID(),
          },

          body:
            JSON.stringify(
              orderPayload,
            ),
        },
      );

    const mpData =
      await mpResponse.json();

    // ========================================================
    // 18. ERRO MERCADO PAGO
    // ========================================================

    if (!mpResponse.ok) {
      console.error(
        "Mercado Pago respondeu com erro:",
        JSON.stringify(
          mpData,
          null,
          2,
        ),
      );

      return json(
        {
          error:
            "O Mercado Pago recusou o pagamento.",

          details:
            mpData,
        },
        502,
      );
    }

    // ========================================================
    // 19. DADOS DO PAGAMENTO
    // ========================================================

    const payment =
      mpData?.transactions
        ?.payments?.[0];

    const paymentMethodResponse =
      payment?.payment_method;

    // ========================================================
    // 20. REGISTRAR COMPRA NO SUPABASE
    // ========================================================

    const {
      data: novaCompra,
      error: insertError,
    } = await supabaseAdmin
      .from("compras")
      .insert({
        cliente_id:
          user.id,

        email_cliente:
          user.email,

        plano_comprado:
          `${produto.nome} - Acesso Vitalício`,

        status_pagamento:
          payment?.status ||
          mpData?.status ||
          "pending",

        codigo_pedido:
          mpData?.id ||
          externalReference,

        data_compra:
          new Date().toISOString(),

        chave_entregue:
          false,
      })
      .select("id")
      .single();

    // ========================================================
    // 21. SE O BANCO RECUSAR O INSERT
    // ========================================================

    if (insertError) {
      console.error(
        "ERRO AO INSERIR COMPRA:",
        JSON.stringify(
          insertError,
          null,
          2,
        ),
      );

      return json(
        {
          error:
            "Não foi possível registrar a compra.",

          details:
            insertError,

          order_id:
            mpData?.id ||
            null,
        },
        500,
      );
    }

    console.log(
      "Compra criada com sucesso:",
      novaCompra?.id,
    );

    // ========================================================
    // 22. RESPOSTA DO PIX
    // ========================================================

    const pixData =
      paymentMethodId === "pix"
        ? {
            qr_code:
              paymentMethodResponse
                ?.qr_code ||
              null,

            qr_code_base64:
              paymentMethodResponse
                ?.qr_code_base64 ||
              null,

            ticket_url:
              paymentMethodResponse
                ?.ticket_url ||
              null,
          }
        : null;

    // ========================================================
    // 23. RESPOSTA FINAL
    // ========================================================

    return json(
      {
        success:
          true,

        order_id:
          mpData.id,

        order_status:
          mpData.status ||
          null,

        payment_status:
          payment?.status ||
          null,

        payment_status_detail:
          payment?.status_detail ||
          null,

        external_reference:
          externalReference,

        message:
          payment?.status ===
          "processed"
            ? "Pagamento aprovado."
            : "Pagamento enviado. Aguarde a confirmação.",

        pix:
          pixData,
      },
      200,
    );

  } catch (error) {
    console.error(
      "ERRO FATAL em processar-pagamento:",
      error,
    );

    return json(
      {
        error:
          "Erro interno ao processar pagamento.",

        message:
          error instanceof Error
            ? error.message
            : String(error),
      },
      500,
    );
  }
});