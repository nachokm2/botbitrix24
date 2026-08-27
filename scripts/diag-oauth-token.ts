import { getState } from '../src/store';

// Diagnóstico: revisa el estado del token OAuth de la app (expiración, dominio) guardado en KV.
// Uso: npx tsx scripts/diag-oauth-token.ts
async function main() {
  const st = await getState();
  if (!st.auth) return console.log('Sin auth guardado (la app no está instalada o el token se perdió).');
  const { access_token, refresh_token, expires_in, domain, member_id, ...resto } = st.auth as any;
  console.log('domain:', domain, '| member_id:', member_id);
  console.log('access_token presente:', !!access_token, '| refresh_token presente:', !!refresh_token);
  console.log('expires_in (del último refresh):', expires_in);
  console.log('otros campos:', JSON.stringify(resto));
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('❌', e);
    process.exit(1);
  });
