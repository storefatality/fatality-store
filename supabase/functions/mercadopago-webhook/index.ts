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
// PARSE DO X-SIGNATURE
// Exemplo:
// ts=1742505638683,v1=abc123...
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

    const cleanKey = key.trim();
    const cleanValue = value.trim();

    if (cleanKey === "ts") {
      ts = cleanValue;
    }

    if (cleanKey === "v1") {
      v1 = cleanValue;
    }
  }

  return { ts, v1 };
}

// ============================================================
// COMPARAÇÃO EM TEMPO CONSTANTE
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
// HMAC SHA-256
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
// VALIDAR ASSINATURA DO MERCADO PAGO
// ============================================================

async function validarAssinaturaMercadoPago(
  req: Request,
  dataId: string,
) {
  const secret =
    Deno.env.get("MP_WEBHOOK_SECRET");

  if (!secret) {
    throw new Error(
      "MP_WEBHOOK_SECRET não configurado.",
    );
  }

  const xSignature =
    req.headers.get("x-signature");

  const xRequestId =
    req.headers.get("x-request-id");

  if (!xSignature) {
    console.error(
      "Webhook sem x-signature.",
    );

    return false;
  }

  const {
    ts,
    v1,
  } = parseSignature(xSignature);

  if (!ts || !v1) {
    console.error(
      "x-signature inválido.",
    );

    return false;
  }

  // Manifest usado para gerar o HMAC
  let manifest = "";

  if (dataId) {
    manifest += `id:${dataId};`;
  }

  if (xRequestId) {
    manifest += `request-id:${xRequestId};`;
  }

  manifest += `ts:${ts};`;

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

  if (!valid) {
    console.error(
      "Assinatura inválida.",
    );

    console.error(
      "Manifest:",
      manifest,
    );
  }

  return valid;
}

// ============================================================
// CONVERTER STATUS DO MERCADO PAGO
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
    orderStatus === "expired" ||
    paymentStatus === "expired"
  ) {
    return "Expirado";
  }

  if (
    orderStatus === "failed" ||
    paymentStatus === "failed"
  ) {
    return "Recusado";
  }

  if (
    orderStatus === "action_required" ||
    paymentStatus === "action_required"
  ) {
    return "Pendente";
  }

  return (
    paymentStatus ||
    orderStatus ||
    "Pendente"
  );
}

// ============================================================
// FUNÇÃO PRINCIPAL
// ============================================================

Deno.serve(async (req) => {
  // ----------------------------------------------------------
  // CORS
  // ----------------------------------------------------------

  if (req.method === "OPTIONS") {
    return new Response("ok", {
      headers: corsHeaders,
    });
  }

  // ----------------------------------------------------------
  // SOMENTE POST
  // ----------------------------------------------------------

  if (req.method !== "POST") {
    return json(
      {
        error:
          "Método não permitido.",
      },
      405,
    );
  }

  try {
    // ========================================================
    // 1. LER URL DO WEBHOOK
    // ========================================================

    const requestUrl =
      new URL(req.url);

    const dataId =
      requestUrl.searchParams.get(
        "data.id",
      );

    const type =
      requestUrl.searchParams.get(
        "type",
      );

    console.log(
      "Webhook recebido:",
      JSON.stringify(
        {
          dataId,
          type,
        },
        null,
        2,
      ),
    );

    // --------------------------------------------------------
    // Ignorar eventos que não sejam Order
    // --------------------------------------------------------

    if (
      type &&
      type !== "order"
    ) {
      console.log(
        "Evento ignorado:",
        type,
      );

      return json({
        ok: true,
        ignored: true,
      });
    }

    if (!dataId) {
      console.error(
        "Webhook sem data.id.",
      );

      return json(
        {
          error:
            "data.id não informado.",
        },
        400,
      );
    }

    // ========================================================
    // 2. VALIDAR ASSINATURA
    // ========================================================

    const assinaturaValida =
      await validarAssinaturaMercadoPago(
        req,
        dataId,
      );

    if (!assinaturaValida) {
      return json(
        {
          error:
            "Assinatura inválida.",
        },
        401,
      );
    }

    console.log(
      "Assinatura validada com sucesso.",
    );

    // ========================================================
    // 3. PEGAR SECRETS
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

    if (
      !mpAccessToken ||
      !supabaseUrl ||
      !secretKeysRaw
    ) {
      throw new Error(
        "Secrets obrigatórios não configurados.",
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
        "Chave secreta do Supabase não encontrada.",
      );
    }

    // ========================================================
    // 4. CLIENTE ADMIN DO SUPABASE
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
    // 5. CONSULTAR ORDER NO MERCADO PAGO
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
            "Não foi possível consultar a Order.",
        },
        502,
      );
    }

    // ========================================================
    // 6. EXTRAIR DADOS
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

    const externalReference =
      order?.external_reference ??
      null;

    const payerEmail =
      order?.payer?.email ??
      null;

    const totalAmount =
      order?.total_amount ??
      null;

    const statusPagamento =
      mapearStatus(
        orderStatus,
        paymentStatus,
      );

    console.log(
      "Order consultada:",
      JSON.stringify(
        {
          order_id:
            order?.id,

          order_status:
            orderStatus,

          payment_status:
            paymentStatus,

          payment_status_detail:
            paymentStatusDetail,

          external_reference:
            externalReference,

          payer_email:
            payerEmail,

          total_amount:
            totalAmount,

          status_pagamento:
            statusPagamento,
        },
        null,
        2,
      ),
    );

    // ========================================================
    // 7. PROCURAR COMPRA EXISTENTE
    // ========================================================

    const {
      data: compraExistente,
      error: buscaError,
    } = await supabaseAdmin
      .from("compras")
      .select(
        "id, cliente_id, email_cliente, plano_comprado, chave_entregue",
      )
      .eq(
        "codigo_pedido",
        dataId,
      )
      .maybeSingle();

    if (buscaError) {
      console.error(
        "Erro procurando compra:",
        buscaError,
      );

      return json(
        {
          error:
            "Erro ao consultar compra.",
        },
        500,
      );
    }

    // ========================================================
    // 8. ATUALIZAR COMPRA EXISTENTE
    // ========================================================

    if (compraExistente) {
      const {
        error: updateError,
      } = await supabaseAdmin
        .from("compras")
        .update({
          status_pagamento:
            statusPagamento,

          // Mantemos a entrega separada
          // da confirmação do pagamento.
          chave_entregue:
            compraExistente.chave_entregue ??
            false,
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

        return json(
          {
            error:
              "Erro ao atualizar compra.",
          },
          500,
        );
      }

      console.log(
        "Compra atualizada:",
        compraExistente.id,
      );

      return json({
        ok: true,

        updated: true,

        created: false,

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
    // 9. PROCURAR CLIENTE PELO EMAIL
    // ========================================================

    let clienteId:
      string | null =
      null;

    if (payerEmail) {
      const {
        data: cliente,
        error: clienteError,
      } = await supabaseAdmin
        .from("clientes")
        .select(
          "id, email",
        )
        .ilike(
          "email",
          payerEmail,
        )
        .maybeSingle();

      if (clienteError) {
        console.error(
          "Erro buscando cliente:",
          clienteError,
        );
      }

      clienteId =
        cliente?.id ??
        null;
    }

    // ========================================================
    // 10. IDENTIFICAR PLANO
    // ========================================================

    let planoComprado =
      "Plano";

    const valor =
      Number(totalAmount);

    if (
      Math.abs(
        valor - 59.90,
      ) < 0.001
    ) {
      planoComprado =
        "FATALITY - Acesso Vitalício";
    }

    if (
      Math.abs(
        valor - 159.90,
      ) < 0.001
    ) {
      planoComprado =
        "BRUTALITY - Acesso Vitalício";
    }

    if (order?.description) {
      planoComprado =
        String(
          order.description,
        );
    }

    // ========================================================
    // 11. CRIAR COMPRA CASO NÃO EXISTA
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
          planoComprado,

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
        "Erro criando compra:",
        insertError,
      );

      return json(
        {
          error:
            "Erro ao registrar compra.",
        },
        500,
      );
    }

    console.log(
      "Nova compra criada:",
      novaCompra?.id,
    );

    // ========================================================
    // 12. RESPONDER AO MERCADO PAGO
    // ========================================================

    return json({
      ok: true,

      updated: false,

      created: true,

      order_id:
        order?.id,

      status_pagamento:
        statusPagamento,

      payment_status:
        paymentStatus,

      payment_status_detail:
        paymentStatusDetail,

      external_reference:
        externalReference,
    });

  } catch (error) {

    console.error(
      "Erro no webhook Mercado Pago:",
      error,
    );

    return json(
      {
        error:
          "Erro interno no webhook.",

        message:
          error instanceof Error
            ? error.message
            : "Erro desconhecido.",
      },
      500,
    );
  }
});