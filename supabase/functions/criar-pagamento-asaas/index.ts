import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const ASAAS_URL = "https://api.asaas.com/v3";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
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

async function asaasRequest(
  path: string,
  options: RequestInit,
  apiKey: string
) {
  const response = await fetch(`${ASAAS_URL}${path}`, {
    ...options,

    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "User-Agent": "FatalityStore/1.0",
      access_token: apiKey,
      ...(options.headers || {}),
    },
  });

  const text = await response.text();

  let data: any;

  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = {
      raw: text,
    };
  }

  if (!response.ok) {
    throw new Error(
      `Asaas ${response.status}: ${JSON.stringify(data)}`
    );
  }

  return data;
}

Deno.serve(async (req) => {
  // =========================================================
  // CORS
  // =========================================================

  if (req.method === "OPTIONS") {
    return new Response("ok", {
      headers: corsHeaders,
    });
  }

  // =========================================================
  // SOMENTE POST
  // =========================================================

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
    // 1. AUTENTICAÇÃO DO USUÁRIO
    // =========================================================

    const authorization =
      req.headers.get("Authorization");

    if (!authorization) {
      return json(
        {
          error: "Authorization não enviada.",
        },
        401
      );
    }

    if (!authorization.startsWith("Bearer ")) {
      return json(
        {
          error: "Authorization inválida.",
        },
        401
      );
    }

    const accessToken = authorization
      .replace("Bearer ", "")
      .trim();

    if (!accessToken) {
      return json(
        {
          error: "Token de acesso vazio.",
        },
        401
      );
    }

    // =========================================================
    // 2. SECRETS
    // =========================================================

    const supabaseUrl =
      Deno.env.get("SUPABASE_URL");

    const supabaseAnonKey =
      Deno.env.get("SUPABASE_ANON_KEY");

    const asaasApiKey =
      Deno.env.get("ASAAS_API_KEY");

    if (!supabaseUrl) {
      return json(
        {
          error:
            "SUPABASE_URL não configurada.",
        },
        500
      );
    }

    if (!supabaseAnonKey) {
      return json(
        {
          error:
            "SUPABASE_ANON_KEY não configurada.",
        },
        500
      );
    }

    if (!asaasApiKey) {
      return json(
        {
          error:
            "ASAAS_API_KEY não configurada.",
        },
        500
      );
    }

    // =========================================================
    // 3. CLIENTE SUPABASE COM JWT DO USUÁRIO
    // =========================================================

    const supabase = createClient(
      supabaseUrl,
      supabaseAnonKey,
      {
        global: {
          headers: {
            Authorization:
              `Bearer ${accessToken}`,
          },
        },
      }
    );

    // =========================================================
    // 4. VALIDAR USUÁRIO
    // =========================================================

    const {
      data: userData,
      error: userError,
    } = await supabase.auth.getUser(accessToken);

    if (userError || !userData?.user) {
      console.error(
        "ERRO AUTH:",
        userError?.message || "Usuário inválido"
      );

      return json(
        {
          error: "Sessão inválida.",
          details:
            userError?.message || null,
        },
        401
      );
    }

    const user =
      userData.user;

    console.log(
      "USUÁRIO AUTENTICADO:",
      user.id,
      user.email
    );

    // =========================================================
    // 5. LER BODY
    // =========================================================

    let body: any;

    try {
      body = await req.json();
    } catch {
      return json(
        {
          error: "JSON inválido.",
        },
        400
      );
    }

    const plano = String(
      body?.plano || ""
    )
      .trim()
      .toLowerCase();

    // =========================================================
    // 6. VALIDAR PLANO
    // =========================================================

    if (
      !["fatality", "brutality"].includes(
        plano
      )
    ) {
      return json(
        {
          error: "Plano inválido.",
        },
        400
      );
    }

    // =========================================================
    // 7. PREÇOS DEFINIDOS NO SERVIDOR
    // =========================================================

    const planos = {
      fatality: {
        nome:
          "FATALITY - Acesso Vitalício",
        valor: 59.9,
        estoque:
          "FATALITY",
      },

      brutality: {
        nome:
          "BRUTALITY - Acesso Vitalício",
        valor: 159.9,
        estoque:
          "BRUTALITY",
      },
    };

    const planoSelecionado =
      planos[
        plano as keyof typeof planos
      ];

    // =========================================================
    // 8. BUSCAR CLIENTE NO FATALITY STORE
    // =========================================================

    const {
      data: cliente,
      error: clienteError,
    } = await supabase
      .from("clientes")
      .select(
        "id, email, nome, cpf_cnpj"
      )
      .eq("id", user.id)
      .maybeSingle();

    if (clienteError) {
      console.error(
        "ERRO AO BUSCAR CLIENTE:",
        JSON.stringify(
          clienteError,
          null,
          2
        )
      );

      return json(
        {
          error:
            "Erro ao consultar cliente.",
          details:
            clienteError.message,
        },
        500
      );
    }

    if (!cliente) {
      return json(
        {
          error:
            "Cliente não encontrado.",
        },
        404
      );
    }

    // =========================================================
    // 9. DADOS DO CLIENTE
    // =========================================================

    const email =
      cliente.email ||
      user.email ||
      "";

    const nome =
      cliente.nome ||
      user.user_metadata?.nome ||
      user.user_metadata?.name ||
      "Cliente Fatality Store";

    const cpfCnpj = String(
      cliente.cpf_cnpj || ""
    )
      .replace(/\D/g, "")
      .trim();

    if (!email) {
      return json(
        {
          error:
            "Usuário sem e-mail cadastrado.",
        },
        400
      );
    }

    if (!cpfCnpj) {
      return json(
        {
          error:
            "Seu cadastro não possui CPF/CNPJ.",
        },
        400
      );
    }

    if (
      cpfCnpj.length !== 11 &&
      cpfCnpj.length !== 14
    ) {
      return json(
        {
          error:
            "CPF/CNPJ possui formato inválido.",
        },
        400
      );
    }

    console.log(
      "DADOS DO CLIENTE:",
      {
        email,
        nome,
        temCpfCnpj:
          Boolean(cpfCnpj),
        quantidadeDigitos:
          cpfCnpj.length,
      }
    );

    // =========================================================
    // 10. PROCURAR CLIENTE NO ASAAS
    // =========================================================

    console.log(
      "PROCURANDO CLIENTE NO ASAAS..."
    );

    const customerSearch =
      await asaasRequest(
        `/customers?cpfCnpj=${encodeURIComponent(
          cpfCnpj
        )}&limit=100`,
        {
          method: "GET",
        },
        asaasApiKey
      );

    let asaasCustomerId:
      | string
      | null = null;

    if (
      Array.isArray(
        customerSearch?.data
      ) &&
      customerSearch.data.length > 0
    ) {
      const encontrado =
        customerSearch.data.find(
          (item: any) =>
            String(
              item?.cpfCnpj || ""
            ).replace(
              /\D/g,
              ""
            ) === cpfCnpj
        );

      if (encontrado?.id) {
        asaasCustomerId =
          encontrado.id;
      }
    }

    // =========================================================
    // 11. CRIAR CLIENTE NO ASAAS
    // =========================================================

    if (!asaasCustomerId) {
      console.log(
        "CLIENTE NÃO ENCONTRADO NO ASAAS. CRIANDO..."
      );

      const novoCliente =
        await asaasRequest(
          "/customers",
          {
            method: "POST",

            body: JSON.stringify({
              name: nome,
              cpfCnpj,
              email,

              externalReference:
                user.id,

              notificationDisabled:
                false,
            }),
          },
          asaasApiKey
        );

      if (!novoCliente?.id) {
        return json(
          {
            error:
              "Asaas não retornou o ID do cliente.",
          },
          500
        );
      }

      asaasCustomerId =
        novoCliente.id;

      console.log(
        "CLIENTE ASAAS CRIADO:",
        asaasCustomerId
      );
    } else {
      console.log(
        "CLIENTE ASAAS ENCONTRADO:",
        asaasCustomerId
      );
    }

    // =========================================================
    // 12. GERAR REFERÊNCIA INTERNA
    // =========================================================

    const externalReference =
      `fs_${plano}_${crypto
        .randomUUID()
        .replaceAll("-", "")
        .slice(0, 20)}`;

    // =========================================================
    // 13. DATA DE VENCIMENTO
    // =========================================================

    const hoje =
      new Date();

    const dueDate =
      `${hoje.getUTCFullYear()}-${String(
        hoje.getUTCMonth() + 1
      ).padStart(2, "0")}-${String(
        hoje.getUTCDate()
      ).padStart(2, "0")}`;

    // =========================================================
    // 14. CRIAR COBRANÇA PIX
    // =========================================================

    console.log(
      "CRIANDO COBRANÇA PIX:",
      {
        plano,
        valor:
          planoSelecionado.valor,
        customer:
          asaasCustomerId,
      }
    );

    const cobranca =
      await asaasRequest(
        "/payments",
        {
          method: "POST",

          body: JSON.stringify({
            customer:
              asaasCustomerId,

            billingType:
              "PIX",

            value:
              planoSelecionado.valor,

            dueDate,

            description:
              planoSelecionado.nome,

            externalReference,
          }),
        },
        asaasApiKey
      );

    if (!cobranca?.id) {
      return json(
        {
          error:
            "Asaas não retornou o ID da cobrança.",
          details: cobranca,
        },
        500
      );
    }

    console.log(
      "COBRANÇA ASAAS CRIADA:",
      cobranca.id
    );

    // =========================================================
    // 15. BUSCAR QR CODE PIX
    // =========================================================

    const pix =
      await asaasRequest(
        `/payments/${cobranca.id}/pixQrCode`,
        {
          method: "GET",
        },
        asaasApiKey
      );

    if (!pix?.payload) {
      console.error(
        "ASAAS NÃO RETORNOU PAYLOAD PIX:",
        JSON.stringify(
          pix,
          null,
          2
        )
      );

      return json(
        {
          error:
            "Cobrança criada, mas o Pix não foi gerado.",
          asaas_payment_id:
            cobranca.id,
        },
        500
      );
    }

    console.log(
      "PIX GERADO COM SUCESSO."
    );

    // =========================================================
    // 16. REGISTRAR COMPRA NO SUPABASE
    // =========================================================

    const {
      data: compra,
      error: compraError,
    } = await supabase
      .from("compras")
      .insert({
        cliente_id:
          user.id,

        email_cliente:
          email,

        plano_comprado:
          planoSelecionado.nome,

        status_pagamento:
          cobranca.status ||
          "PENDING",

        codigo_pedido:
          cobranca.id,

        data_compra:
          new Date().toISOString(),

        chave_entregue:
          false,
      })
      .select()
      .maybeSingle();

    if (compraError) {
      console.error(
        "ERRO AO REGISTRAR COMPRA:",
        JSON.stringify(
          compraError,
          null,
          2
        )
      );

      return json(
        {
          error:
            "Cobrança criada, mas não foi possível registrar a compra.",

          details:
            compraError.message,

          asaas_payment_id:
            cobranca.id,
        },
        500
      );
    }

    // =========================================================
    // 17. RETORNO PARA O FRONTEND
    // =========================================================

    return json({
      success: true,

      plano,

      nome_plano:
        planoSelecionado.nome,

      valor:
        planoSelecionado.valor,

      compra_id:
        compra?.id || null,

      asaas: {
        customer_id:
          asaasCustomerId,

        payment_id:
          cobranca.id,

        status:
          cobranca.status ||
          "PENDING",

        external_reference:
          externalReference,

        invoice_url:
          cobranca.invoiceUrl ||
          null,
      },

      pix: {
        encoded_image:
          pix.encodedImage ||
          null,

        payload:
          pix.payload ||
          null,

        expiration_date:
          pix.expirationDate ||
          null,
      },
    });
  } catch (error) {
    console.error(
      "ERRO GERAL CRIAR PAGAMENTO ASAAS:",
      error
    );

    return json(
      {
        error:
          "Erro ao criar pagamento no Asaas.",

        details:
          error instanceof Error
            ? error.message
            : String(error),
      },
      500
    );
  }
});