import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "content-type, x-signature, x-request-id",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

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
// PARSE X-SIGNATURE
// ============================================================

function parseSignature(header: string | null) {
  if (!header) {
    return {
      ts: null,
      v1: null,
    };
  }

  let ts: string | null = null;
  let v1: string | null = null;

  for (const part of header.split(",")) {
    const [key, value] = part.split("=", 2);

    if (!key || !value) continue;

    if (key.trim() === "ts") {
      ts = value.trim();
    }

    if (key.trim() === "v1") {
      v1 = value.trim();
    }
  }

  return { ts, v1 };
}

// ============================================================
// COMPARAÇÃO SEGURA
// ============================================================

function constantTimeEqual(a: string, b: string) {
  if (a.length !== b.length) {
    return false;
  }

  let result = 0;

  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }

  return result === 0;
}

// ============================================================
// HMAC SHA256
// ============================================================

async function hmacSha256Hex(
  secret: string,
  message: string,
) {
  const encoder = new TextEncoder();

  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    {
      name: "HMAC",
      hash: "SHA-256",
    },
    false,
    ["sign"],
  );

  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(message),
  );

  return Array.from(new Uint8Array(signature))
    .map((byte) =>
      byte.toString(16).padStart(2, "0")
    )
    .join("");
}

// ============================================================
// VALIDAR ASSINATURA MERCADO PAGO
// ============================================================

async function validarAssinatura(
  req: Request,
  dataId: string,
) {
  const secret =
    Deno.env.get("MP_WEBHOOK_SECRET");

  if (!secret) {
    console.error(
      "ERRO: MP_WEBHOOK_SECRET não encontrado.",
    );

    return false;
  }

  const signature =
    req.headers.get("x-signature");

  const requestId =
    req.headers.get("x-request-id");

  if (!signature) {
    console.error(
      "ERRO: x-signature não recebido.",
    );

    return false;
  }

  const {
    ts,
    v1,
  } = parseSignature(signature);

  if (!ts || !v1) {
    console.error(
      "ERRO: x-signature está incompleto.",
    );

    return false;
  }

  let manifest = "";

  manifest += `id:${dataId};`;

  if (requestId) {
    manifest += `request-id:${requestId};`;
  }

  manifest += `ts:${ts};`;

  console.log(
    "Manifest:",
    manifest,
  );

  const calculated =
    await hmacSha256Hex(
      secret,
      manifest,
    );

  const valid =
    constantTimeEqual(
      calculated,
      v1,
    );

  console.log(
    "Assinatura válida:",
    valid,
  );

  return valid;
}

// ============================================================
// MAPEAR STATUS
// ============================================================

function mapearStatus(
  orderStatus: string | null,
  paymentStatus: string | null,
) {
  if (
    orderStatus === "processed" ||
    paymentStatus === "processed"
  ) {
    return "Pago";
  }

  if (
    orderStatus === "canceled" ||
    paymentStatus === "canceled"
  ) {
    return "Cancelado";
  }

  if (
    orderStatus === "failed" ||
    paymentStatus === "failed"
  ) {
    return "Recusado";
  }

  if (
    orderStatus === "expired" ||
    paymentStatus === "expired"
  ) {
    return "Expirado";
  }

  return "Pendente";
}

// ============================================================
// FUNÇÃO PRINCIPAL
// ============================================================

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", {
      headers: corsHeaders,
    });
  }

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
    // 1. URL
    // ========================================================

    const url = new URL(req.url);

    const dataId =
      url.searchParams.get("data.id");

    const type =
      url.searchParams.get("type");

    // ========================================================
    // 2. BODY
    // ========================================================

    const body =
      await req.json().catch(() => ({}));

    console.log(
      "WEBHOOK RECEBIDO:",
      JSON.stringify(
        {
          type,
          dataId,
          body,
        },
        null,
        2,
      ),
    );

    // ========================================================
    // 3. TESTE DE URL SEM DATA.ID
    // ========================================================

    if (!dataId) {
      return json({
        ok: true,
        message:
          "Webhook ativo e acessível.",
      });
    }

    // ========================================================
    // 4. SOMENTE ORDER
    // ========================================================

    if (
      type &&
      type !== "order"
    ) {
      return json({
        ok: true,
        ignored: true,
        reason:
          "Evento não é Order.",
      });
    }

    // ========================================================
    // 5. VALIDAR ASSINATURA
    // ========================================================

    const assinaturaValida =
      await validarAssinatura(
        req,
        dataId,
      );

    if (!assinaturaValida) {
      return json(
        {
          error:
            "Assinatura do Mercado Pago inválida.",
        },
        401,
      );
    }

    // ========================================================
    // 6. PEGAR SECRETS
    // ========================================================

    const mpAccessToken =
      Deno.env.get(
        "MP_ACCESS_TOKEN",
      );

    const supabaseUrl =
      Deno.env.get(
        "SUPABASE_URL",
      );

    const secretKeysRaw =
      Deno.env.get(
        "SUPABASE_SECRET_KEYS",
      );

    if (!mpAccessToken) {
      throw new Error(
        "MP_ACCESS_TOKEN não configurado.",
      );
    }

    if (!supabaseUrl) {
      throw new Error(
        "SUPABASE_URL não configurado.",
      );
    }

    if (!secretKeysRaw) {
      throw new Error(
        "SUPABASE_SECRET_KEYS não encontrado.",
      );
    }

    const secretKeys =
      JSON.parse(
        secretKeysRaw,
      );

    const supabaseSecretKey =
      secretKeys.default;

    if (!supabaseSecretKey) {
      throw new Error(
        "Chave secreta padrão do Supabase não encontrada.",
      );
    }

    // ========================================================
    // 7. CLIENT ADMIN
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
    // 8. SIMULADOR DO MERCADO PAGO
    //
    // O simulador usa IDs como:
    // ORDTST...
    //
    // Não devemos procurar isso na API real.
    // ========================================================

    const isMercadoPagoSimulator =
      dataId.startsWith(
        "ORDTST",
      );

    if (isMercadoPagoSimulator) {
      console.log(
        "SIMULAÇÃO DO MERCADO PAGO DETECTADA.",
      );

      const simulationAction =
        body?.action ??
        null;

      return json({
        ok: true,

        simulated: true,

        message:
          "Webhook de teste recebido corretamente.",

        action:
          simulationAction,

        order_id:
          dataId,
      });
    }

    // ========================================================
    // 9. ORDER REAL
    // ========================================================

    const orderResponse =
      await fetch(
        `https://api.mercadopago.com/v1/orders/${encodeURIComponent(
          dataId,
        )}`,
        {
          method: "GET",

          headers: {
            Accept:
              "application/json",

            Authorization:
              `Bearer ${mpAccessToken}`,
          },
        },
      );

    const order =
      await orderResponse.json();

    if (!orderResponse.ok) {
      console.error(
        "Erro ao consultar Order:",
        JSON.stringify(
          order,
          null,
          2,
        ),
      );

      return json(
        {
          error:
            "Erro ao consultar Order no Mercado Pago.",

          details:
            order,
        },
        502,
      );
    }

    // ========================================================
    // 10. DADOS DA ORDER
    // ========================================================

    const payment =
      order?.transactions
        ?.payments?.[0] ??
      null;

    const orderStatus =
      order?.status ??
      null;

    const paymentStatus =
      payment?.status ??
      null;

    const paymentStatusDetail =
      payment?.status_detail ??
      null;

    const payerEmail =
      order?.payer?.email ??
      null;

    const totalAmount =
      Number(
        order?.total_amount ?? 0,
      );

    const statusPagamento =
      mapearStatus(
        orderStatus,
        paymentStatus,
      );

    console.log(
      "ORDER REAL:",
      JSON.stringify(
        {
          id: order?.id,
          status: orderStatus,
          paymentStatus,
          paymentStatusDetail,
          payerEmail,
          totalAmount,
        },
        null,
        2,
      ),
    );

    // ========================================================
    // 11. PROCURAR COMPRA PELO CODIGO DO PEDIDO
    // ========================================================

    const {
      data: compraExistente,
      error: compraBuscaError,
    } = await supabaseAdmin
      .from("compras")
      .select(
        "id, cliente_id, chave_entregue",
      )
      .eq(
        "codigo_pedido",
        dataId,
      )
      .maybeSingle();

    if (compraBuscaError) {
      console.error(
        "Erro buscando compra:",
        compraBuscaError,
      );

      throw compraBuscaError;
    }

    // ========================================================
    // 12. SE JÁ EXISTE, ATUALIZA
    // ========================================================

    if (compraExistente) {
      const {
        error: updateError,
      } = await supabaseAdmin
        .from("compras")
        .update({
          status_pagamento:
            statusPagamento,
        })
        .eq(
          "id",
          compraExistente.id,
        );

      if (updateError) {
        console.error(
          "Erro atualizando compra:",
          updateError,
        );

        throw updateError;
      }

      console.log(
        "Compra atualizada:",
        compraExistente.id,
      );

      return json({
        ok: true,

        updated: true,

        order_id:
          order?.id,

        status_pagamento:
          statusPagamento,

        payment_status:
          paymentStatus,

        payment_status_detail:
          paymentStatusDetail,
      });
    }

    // ========================================================
    // 13. ENCONTRAR CLIENTE
    // ========================================================

    let clienteId:
      string | null =
      null;

    if (payerEmail) {
      const {
        data: cliente,
      } = await supabaseAdmin
        .from("clientes")
        .select("id")
        .eq(
          "email",
          payerEmail,
        )
        .maybeSingle();

      clienteId =
        cliente?.id ??
        null;
    }

    // ========================================================
    // 14. IDENTIFICAR PLANO
    // ========================================================

    let plano =
      "Plano";

    if (
      Math.abs(
        totalAmount - 59.90,
      ) < 0.001
    ) {
      plano =
        "FATALITY - Acesso Vitalício";
    }

    if (
      Math.abs(
        totalAmount - 159.90,
      ) < 0.001
    ) {
      plano =
        "BRUTALITY - Acesso Vitalício";
    }

    if (order?.description) {
      plano =
        String(
          order.description,
        );
    }

    // ========================================================
    // 15. CRIAR COMPRA
    // ========================================================

    const {
      data: novaCompra,
      error: insertError,
    } = await supabaseAdmin
      .from("compras")
      .insert({
        cliente_id:
          clienteId,

        email_cliente:
          payerEmail,

        plano_comprado:
          plano,

        status_pagamento:
          statusPagamento,

        codigo_pedido:
          order?.id ??
          dataId,

        data_compra:
          order?.date_created ??
          new Date().toISOString(),

        chave_entregue:
          false,
      })
      .select("id")
      .single();

    if (insertError) {
      console.error(
        "Erro inserindo compra:",
        insertError,
      );

      throw insertError;
    }

    console.log(
      "Compra criada:",
      novaCompra?.id,
    );

    return json({
      ok: true,

      created: true,

      order_id:
        order?.id,

      status_pagamento:
        statusPagamento,
    });

  } catch (error) {
    console.error(
      "ERRO FATAL WEBHOOK:",
      error,
    );

    return json(
      {
        error:
          "Erro interno no webhook.",

        message:
          error instanceof Error
            ? error.message
            : String(error),
      },
      500,
    );
  }
});