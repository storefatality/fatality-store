import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "content-type, x-case-sync-token",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json",
    },
  });
}

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
      405
    );
  }

  try {
    // =========================================================
    // 1. AUTENTICAÇÃO DO WEBHOOK
    // =========================================================

    const receivedToken =
      req.headers.get("x-case-sync-token");

    const configuredToken =
      Deno.env.get("CASE_SYNC_TOKEN");

    if (!configuredToken) {
      console.error(
        "CASE_SYNC_TOKEN não configurado."
      );

      return json(
        {
          error:
            "CASE_SYNC_TOKEN não configurado.",
        },
        500
      );
    }

    if (
      !receivedToken ||
      receivedToken !== configuredToken
    ) {
      return json(
        {
          error: "Não autorizado.",
        },
        401
      );
    }

    // =========================================================
    // 2. SECRETS
    // =========================================================

    const siteUrl =
      Deno.env.get("SUPABASE_URL");

    const siteServiceRoleKey =
      Deno.env.get(
        "SUPABASE_SERVICE_ROLE_KEY"
      );

    const appSupabaseUrl =
      Deno.env.get(
        "APP_SUPABASE_URL"
      );

    const appSupabaseServiceRoleKey =
      Deno.env.get(
        "APP_SUPABASE_SERVICE_ROLE_KEY"
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

    if (!siteServiceRoleKey) {
      return json(
        {
          error:
            "SUPABASE_SERVICE_ROLE_KEY não configurada.",
        },
        500
      );
    }

    if (!appSupabaseUrl) {
      return json(
        {
          error:
            "APP_SUPABASE_URL não configurada.",
        },
        500
      );
    }

    if (!appSupabaseServiceRoleKey) {
      return json(
        {
          error:
            "APP_SUPABASE_SERVICE_ROLE_KEY não configurada.",
        },
        500
      );
    }

    // =========================================================
    // 3. CLIENTES ADMINISTRATIVOS
    // =========================================================

    const siteSupabase = createClient(
      siteUrl,
      siteServiceRoleKey
    );

    const appSupabase = createClient(
      appSupabaseUrl,
      appSupabaseServiceRoleKey
    );

    // =========================================================
    // 4. LER PAYLOAD
    // =========================================================

    let payload: any = null;

    try {
      payload = await req.json();
    } catch {
      payload = {};
    }

    const record =
      payload?.record || null;

    const eventType =
      payload?.type || null;

    // =========================================================
    // 5. FUNÇÃO DE SINCRONIZAÇÃO
    // =========================================================

    async function sincronizarKey(key: any) {
      if (!key?.id) {
        return {
          success: false,
          reason: "ID_DA_KEY_AUSENTE",
        };
      }

      const origemId =
        String(key.id);

      const planoOriginal =
        String(key.plan || "")
          .trim()
          .toLowerCase();

      const chave =
        String(key.key || "")
          .trim();

      const statusOriginal =
        String(key.status || "")
          .trim()
          .toLowerCase();

      if (!chave) {
        return {
          success: false,
          reason: "CHAVE_VAZIA",
          origem_access_key_id:
            origemId,
        };
      }

      // Só aceitamos estes dois planos.
      let planoSite: string | null = null;

      if (planoOriginal === "fatality") {
        planoSite = "FATALITY";
      }

      if (planoOriginal === "brutality") {
        planoSite = "BRUTALITY";
      }

      if (!planoSite) {
        return {
          success: false,
          reason: "PLANO_NAO_RECONHECIDO",
          plan: planoOriginal,
          origem_access_key_id:
            origemId,
        };
      }

      // =======================================================
      // STATUS
      // =======================================================

      let statusSite =
        "Indisponível";

      if (statusOriginal === "active") {
        statusSite = "Disponível";
      }

      // =======================================================
      // VERIFICAR SE JÁ EXISTE
      // =======================================================

      const {
        data: existente,
        error: existenteError,
      } = await siteSupabase
        .from("estoque_keys")
        .select(
          "id, status, email_cliente, origem_access_key_id"
        )
        .eq(
          "origem_access_key_id",
          origemId
        )
        .maybeSingle();

      if (existenteError) {
        throw new Error(
          `Erro consultando estoque: ${existenteError.message}`
        );
      }

      // =======================================================
      // SE JÁ EXISTE
      // =======================================================

      if (existente) {
        // Não sobrescrevemos uma chave que já foi entregue
        // pelo site.
        if (
          existente.status === "Entregue"
        ) {
          return {
            success: true,
            action: "IGNORED_ALREADY_DELIVERED",
            origem_access_key_id:
              origemId,
            site_estoque_id:
              existente.id,
          };
        }

        const {
          error: updateError,
        } = await siteSupabase
          .from("estoque_keys")
          .update({
            plano: planoSite,
            status: statusSite,
          })
          .eq(
            "id",
            existente.id
          );

        if (updateError) {
          throw new Error(
            `Erro atualizando estoque: ${updateError.message}`
          );
        }

        return {
          success: true,
          action: "UPDATED",
          origem_access_key_id:
            origemId,
          site_estoque_id:
            existente.id,
        };
      }

      // =======================================================
      // CRIAR NOVA KEY
      // =======================================================

      const {
        data: novaKey,
        error: insertError,
      } = await siteSupabase
        .from("estoque_keys")
        .insert({
          origem_access_key_id:
            origemId,

          plano:
            planoSite,

          chave:

            chave,

          status:
            statusSite,

          email_cliente:
            key.email || null,
        })
        .select(
          "id, plano, chave, status, origem_access_key_id"
        )
        .maybeSingle();

      if (insertError) {
        // Pode ser corrida entre dois webhooks.
        if (
          String(
            insertError.message || ""
          )
            .toLowerCase()
            .includes("duplicate")
        ) {
          return {
            success: true,
            action:
              "ALREADY_IMPORTED",
            origem_access_key_id:
              origemId,
          };
        }

        throw new Error(
          `Erro inserindo estoque: ${insertError.message}`
        );
      }

      return {
        success: true,
        action: "INSERTED",
        origem_access_key_id:
          origemId,
        site_estoque_id:
          novaKey?.id || null,
        plano: planoSite,
        status: statusSite,
      };
    }

    // =========================================================
    // 6. SINCRONIZAÇÃO COMPLETA INICIAL
    // =========================================================

    const url =
      new URL(req.url);

    const mode =
      url.searchParams.get("mode");

    if (
      mode === "full" ||
      payload?.mode === "full"
    ) {
      console.log(
        "INICIANDO SINCRONIZAÇÃO COMPLETA..."
      );

      const {
        data: keys,
        error: keysError,
      } = await appSupabase
        .from("access_keys")
        .select(
          "id, key, status, plan, email, created_at"
        )
        .eq(
          "status",
          "active"
        )
        .in(
          "plan",
          [
            "fatality",
            "brutality",
          ]
        )
        .order(
          "created_at",
          {
            ascending: true,
          }
        );

      if (keysError) {
        console.error(
          "ERRO AO BUSCAR KEYS DO APP:",
          keysError
        );

        return json(
          {
            error:
              "Não foi possível consultar o estoque do aplicativo.",
            details:
              keysError.message,
          },
          500
        );
      }

      let inserted = 0;
      let updated = 0;
      let ignored = 0;
      let errors = 0;

      const results = [];

      for (const key of keys || []) {
        try {
          const resultado =
            await sincronizarKey(
              key
            );

          results.push(
            resultado
          );

          if (
            resultado.action ===
            "INSERTED"
          ) {
            inserted++;
          } else if (
            resultado.action ===
            "UPDATED"
          ) {
            updated++;
          } else {
            ignored++;
          }
        } catch (error) {
          errors++;

          console.error(
            "ERRO SINCRONIZANDO KEY:",
            error
          );

          results.push({
            success: false,
            error:
              error instanceof Error
                ? error.message
                : String(error),
            origem_access_key_id:
              key?.id || null,
          });
        }
      }

      return json({
        success: true,
        mode: "full",

        total_app_keys:
          keys?.length || 0,

        inserted,
        updated,
        ignored,
        errors,
      });
    }

    // =========================================================
    // 7. SINCRONIZAÇÃO DE UM EVENTO
    // =========================================================

    if (
      eventType === "DELETE"
    ) {
      const oldRecord =
        payload?.old_record;

      if (
        !oldRecord?.id
      ) {
        return json({
          success: true,
          action:
            "DELETE_WITHOUT_ID",
        });
      }

      const {
        error: deleteError,
      } = await siteSupabase
        .from("estoque_keys")
        .delete()
        .eq(
          "origem_access_key_id",
          oldRecord.id
        )
        .neq(
          "status",
          "Entregue"
        );

      if (deleteError) {
        throw deleteError;
      }

      return json({
        success: true,
        action: "DELETED",
        origem_access_key_id:
          oldRecord.id,
      });
    }

    if (!record?.id) {
      return json({
        success: true,
        action:
          "NO_RECORD",
      });
    }

    const resultado =
      await sincronizarKey(
        record
      );

    return json(
      resultado,
      resultado?.success
        ? 200
        : 400
    );
  } catch (error) {
    console.error(
      "ERRO GERAL SYNC ACCESS KEY:",
      error
    );

    return json(
      {
        error:
          "Erro na sincronização do estoque.",
        details:
          error instanceof Error
            ? error.message
            : String(error),
      },
      500
    );
  }
});