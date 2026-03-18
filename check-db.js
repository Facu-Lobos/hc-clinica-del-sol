import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.VITE_SUPABASE_URL;
const supabaseKey = process.env.VITE_SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error("Missing VITE_SUPABASE_URL or VITE_SUPABASE_ANON_KEY in environment");
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

async function checkUserAndProfile() {
  console.log("Checking authentication users...");
  // Attempt to check if we can query anything from auth... wait, anon key can't query auth.users usually.
  
  // Let's check the profiles table without limit 1 to see its contents
  console.log("Fetching all rows from profiles table...");
  const { data, error } = await supabase
    .from('profiles')
    .select('*');

  if (error) {
    console.error("Error querying profiles:", error);
  } else {
    console.log(`Found ${data?.length || 0} rows in profiles table.`);
    console.log("Data:", data);
  }
}

checkUserAndProfile();
