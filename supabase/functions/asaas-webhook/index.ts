import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "content-type, asaas-access-token",
  "Access-Control-Allow-Methods":
    "POST, OPTIONS",
};

function json(
  data: unknown,
  status = 200
) {
  return new Response(
    JSON.stringify(data),
    {
      status,
      headers: {
        ...corsHeaders,
        "Content-Type":
          "application/json",
      },
    }
  );
}

function normalizarPlano(
  plano: string
) {
  const valor = String(
    plano || ""
  )
    .trim()
    .toUpperCase();

  if (valor.startsWith("FATALITY")) {
    return "fatality";
  }

  if (valor.startsWith("BRUTALITY")) {
    return "brutality";
  }

  return null;
}

Deno.serve(async (req) => {
  // =========================================================
  // CORS
  // =========================================================

  if (req.method === "OPTIONS") {
    return new Response(
      "ok",
      {
        headers:
          corsHeaders,
      }
    );
  }

  // =========================================================
  // SOMENTE POST
  // =========================================================

  if (req.method !== "POST") {
    return json(
      {
        error:
          "Método não permitido.",
      },
      405
    );
  }

  try {
    // =======================================================
    // 1. VALIDAR TOKEN DO ASAAS
    // =======================================================

    const receivedToken =
      req.headers.get(
        "asaas-access-token"
      );

    const configuredToken =
      Deno.env.get(
        "ASAAS_WEBHOOK_TOKEN"
      );

    if (!configuredToken) {
      console.error(
        "ASAAS_WEBHOOK_TOKEN não configurado."
      );

      return json(
        {
          error:
            "Webhook não configurado.",
        },
        500
      );
    }

    if (
      !receivedToken ||
      receivedToken !==
        configuredToken
    ) {
      console.error(
        "Token do webhook inválido."
      );

      return json(
        {
          error:
            "Não autorizado.",
        },
        401
      );
    }

    // =======================================================
    // 2. LER PAYLOAD
    // =======================================================

    const payload =
      await req.json();

    const eventId =
      payload?.id || null;

    const event =
      payload?.event || null;

    const payment =
      payload?.payment || null;

    const paymentId =
      payment?.id || null;

    const paymentStatus =
      payment?.status || null;

    if (
      !event ||
      !paymentId
    ) {
      console.error(
        "PAYLOAD INVÁLIDO."
      );

      return json(
        {
          error:
            "Payload inválido.",
        },
        400
      );
    }

    console.log(
      "WEBHOOK ASAAS:",
      JSON.stringify(
        {
          eventId,
          event,
          paymentId,
          paymentStatus,
        },
        null,
        2
      )
    );

    // =======================================================
    // 3. SÓ PROCESSAR PAYMENT_RECEIVED
    // =======================================================

    if (
      event !==
      "PAYMENT_RECEIVED"
    ) {
      console.log(
        "Evento ignorado:",
        event
      );

      return json({
        received: true,
        processed: false,
        ignored: true,
        event,
      });
    }

    // =======================================================
    // 4. SUPABASE DO SITE
    // =======================================================

    const siteUrl =
      Deno.env.get(
        "SUPABASE_URL"
      );

    const siteServiceRoleKey =
      Deno.env.get(
        "SUPABASE_SERVICE_ROLE_KEY"
      );

    if (!siteUrl) {
      return json(
        {
          error:
            "SUPABASE_URL não configurada.",
        },
        500
      );
    }

    if (
      !siteServiceRoleKey
    ) {
      return json(
        {
          error:
            "SUPABASE_SERVICE_ROLE_KEY não configurada.",
        },
        500
      );
    }

    const supabase =
      createClient(
        siteUrl,
        siteServiceRoleKey
      );

    // =======================================================
    // 5. SUPABASE DO APLICATIVO
    // =======================================================

    const appSupabaseUrl =
      Deno.env.get(
        "APP_SUPABASE_URL"
      );

    const appSupabaseServiceRoleKey =
      Deno.env.get(
        "APP_SUPABASE_SERVICE_ROLE_KEY"
      );

    if (
      !appSupabaseUrl
    ) {
      return json(
        {
          error:
            "APP_SUPABASE_URL não configurada.",
        },
        500
      );
    }

    if (
      !appSupabaseServiceRoleKey
    ) {
      return json(
        {
          error:
            "APP_SUPABASE_SERVICE_ROLE_KEY não configurada.",
        },
        500
      );
    }

    const appSupabase =
      createClient(
        appSupabaseUrl,
        appSupabaseServiceRoleKey
      );

    // =======================================================
    // 6. LOCALIZAR A COMPRA
    // =======================================================

    console.log(
      "Buscando compra pelo payment.id:",
      paymentId
    );

    const {
      data: compra,
      error: compraError,
    } = await supabase
      .from("compras")
      .select(
        `
        id,
        cliente_id,
        email_cliente,
        plano_comprado,
        status_pagamento,
        codigo_pedido,
        chave_entregue,
        chave_entregue_valor
        `
      )
      .eq(
        "codigo_pedido",
        paymentId
      )
      .maybeSingle();

    if (compraError) {
      console.error(
        "ERRO AO BUSCAR COMPRA:",
        JSON.stringify(
          compraError,
          null,
          2
        )
      );

      return json(
        {
          error:
            "Erro ao consultar compra.",
        },
        500
      );
    }

    if (!compra) {
      console.error(
        "COMPRA NÃO ENCONTRADA:",
        paymentId
      );

      return json({
        received: true,
        processed: false,
        reason:
          "Compra não encontrada.",
        paymentId,
      });
    }

    console.log(
      "COMPRA ENCONTRADA:",
      {
        id: compra.id,
        plano:
          compra.plano_comprado,
        status:
          compra.status_pagamento,
        chave_entregue:
          compra.chave_entregue,
      }
    );

    // =======================================================
    // 7. SE JÁ POSSUI KEY, NÃO CONSUMIR OUTRA
    // =======================================================

    if (
      compra.chave_entregue === true &&
      compra.chave_entregue_valor
    ) {
      console.log(
        "COMPRA JÁ POSSUI KEY. NADA A CONSUMIR."
      );

      // Garante que o status de pagamento esteja correto.
      if (
        compra.status_pagamento !==
        "RECEIVED"
      ) {
        const {
          error: statusError,
        } = await supabase
          .from("compras")
          .update({
            status_pagamento:
              "RECEIVED",
          })
          .eq(
            "id",
            compra.id
          );

        if (statusError) {
          console.error(
            "ERRO ATUALIZANDO STATUS:",
            statusError
          );

          return json(
            {
              error:
                "Erro ao atualizar status.",
            },
            500
          );
        }
      }

      return json({
        received: true,
        processed: true,
        already_delivered:
          true,
        paymentId,
        status:
          "RECEIVED",
      });
    }

    // =======================================================
    // 8. ATUALIZAR PAGAMENTO
    // =======================================================

    const {
      error: statusUpdateError,
    } = await supabase
      .from("compras")
      .update({
        status_pagamento:
          "RECEIVED",
      })
      .eq(
        "id",
        compra.id
      );

    if (statusUpdateError) {
      console.error(
        "ERRO AO ATUALIZAR STATUS:",
        JSON.stringify(
          statusUpdateError,
          null,
          2
        )
      );

      return json(
        {
          error:
            "Não foi possível atualizar o pagamento.",
        },
        500
      );
    }

    // =======================================================
    // 9. DETERMINAR PLANO
    // =======================================================

    const planoApp =
      normalizarPlano(
        compra.plano_comprado
      );

    if (!planoApp) {
      console.error(
        "PLANO NÃO RECONHECIDO:",
        compra.plano_comprado
      );

      return json(
        {
          error:
            "Plano não reconhecido.",
          plano:
            compra.plano_comprado,
        },
        500
      );
    }

    console.log(
      "Plano para retirada:",
      planoApp
    );

    // =======================================================
    // 10. PEDIR UMA KEY AO SUPABASE DO APP
    // =======================================================

    const {
      data: entrega,
      error: entregaError,
    } =
      await appSupabase.rpc(
        "claim_access_key",
        {
          p_plan:
            planoApp,

          p_purchase_id:
            compra.id,

          p_email:
            compra.email_cliente,
        }
      );

    if (entregaError) {
      console.error(
        "ERRO AO RETIRAR KEY DO APP:",
        JSON.stringify(
          entregaError,
          null,
          2
        )
      );

      return json(
        {
          error:
            "Erro ao obter key do aplicativo.",
          details:
            entregaError.message,
        },
        500
      );
    }

    // =======================================================
    // 11. SEM ESTOQUE
    // =======================================================

    if (
      !entrega ||
      entrega.success !== true
    ) {
      console.error(
        "SEM ESTOQUE:",
        JSON.stringify(
          entrega,
          null,
          2
        )
      );

      // HTTP 500 para permitir nova tentativa
      // do webhook quando necessário.
      return json(
        {
          error:
            "Pagamento recebido, mas não há key disponível.",
          reason:
            entrega?.reason ||
            "SEM_ESTOQUE",
          plan:
            planoApp,
        },
        500
      );
    }

    // =======================================================
    // 12. PEGAR A KEY RETORNADA
    // =======================================================

    const accessKey =
      entrega.key || null;

    const accessKeyId =
      entrega.access_key_id ||
      null;

    if (!accessKey) {
      console.error(
        "APP RETORNOU SUCESSO MAS SEM KEY."
      );

      return json(
        {
          error:
            "O aplicativo reservou uma key, mas não retornou o valor.",
          accessKeyId,
        },
        500
      );
    }

    // =======================================================
    // 13. SALVAR A KEY NA COMPRA
    // =======================================================

    const {
      error: salvarKeyError,
    } = await supabase
      .from("compras")
      .update({
        chave_entregue:
          true,

        chave_entregue_valor:
          accessKey,
      })
      .eq(
        "id",
        compra.id
      );

    if (salvarKeyError) {
      console.error(
        "ERRO AO SALVAR KEY NA COMPRA:",
        JSON.stringify(
          salvarKeyError,
          null,
          2
        )
      );

      return json(
        {
          error:
            "A key foi reservada no aplicativo, mas não foi salva na compra.",
          details:
            salvarKeyError.message,
          accessKeyId,
        },
        500
      );
    }

    // =======================================================
    // 14. SUCESSO
    // =======================================================

    console.log(
      "KEY ENTREGUE COM SUCESSO.",
      {
        paymentId,
        compraId:
          compra.id,
        accessKeyId,
        plano:
          planoApp,
        alreadyClaimed:
          entrega.already_claimed ||
          false,
      }
    );

    // NÃO retornamos a key aqui.
    // Isso evita expor a credencial em logs do webhook.

    return json({
      received: true,
      processed: true,

      eventId,
      paymentId,

      status:
        "RECEIVED",

      plano:
        planoApp,

      key_entregue:
        true,

      access_key_id:
        accessKeyId,

      already_claimed:
        entrega.already_claimed ||
        false,
    });
  } catch (error) {
    console.error(
      "ERRO GERAL DO WEBHOOK ASAAS:",
      error
    );

    return json(
      {
        error:
          "Erro interno no webhook.",
        details:
          error instanceof Error
            ? error.message
            : String(error),
      },
      500
    );
  }
});