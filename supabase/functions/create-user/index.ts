import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.44.4";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

serve(async (req) => {
  // Handle CORS preflight requests
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const supabaseClient = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    );

    // Get the request body
    const { username, password, profileData } = await req.json();

    if (!username || !password || !profileData) {
       return new Response(JSON.stringify({ error: "Faltan parámetros obligatorios" }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 400,
      });
    }

    // 1. Create the user in auth.users using the admin API
    const email = username.includes('@') ? username : `${username}@clinica.local`;
    const { data: authData, error: authError } = await supabaseClient.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    });

    if (authError) {
      throw authError;
    }

    const userId = authData.user.id;

    // 2. Insert the profile data into public.profiles
    const { data: profileResult, error: profileError } = await supabaseClient
      .from('profiles')
      .insert({
        id: userId,
        username: username,
        ...profileData
      })
      .select()
      .single();

    if (profileError) {
      // Rollback user creation if profile fails (ideally)
      await supabaseClient.auth.admin.deleteUser(userId);
      throw profileError;
    }

    // Return success
    return new Response(JSON.stringify({ user: authData.user, profile: profileResult }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 200,
    });

  } catch (error: any) {
    return new Response(JSON.stringify({ error: error.message }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 400,
    });
  }
});
