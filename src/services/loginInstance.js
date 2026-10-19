import axios from 'axios';

export async function loginInstance(instance, username, password, code, loginOptions) {
  const postData = {
    username: username, 
    password: password,
    code: code,
    trusted: false, // ou true se quiser manter a sessão por mais tempo
  };
  
  try {
    const loginResponse = await axios.post(`${instance}/login`, postData, {
      ...(loginOptions?.maxRedirects === 0 ? { maxRedirects: 0 } : {}),
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json', // Solicita explicitamente JSON ao servidor
      },
    });

    

    // Validação: Verifica se recebemos um token válido
    if (!loginResponse.data || !loginResponse.data.token) {
        // Se a resposta for uma string (provavelmente HTML), limita o log para não poluir o terminal
        const responseDataSample = typeof loginResponse.data === 'string'
            ? loginResponse.data.substring(0, 100) + '...'
            : JSON.stringify(loginResponse.data);

        throw new Error(`Login falhou: Servidor não retornou um token. Resposta: ${responseDataSample}`);
    }

    console.log('Login bem-sucedido, token recebido.');
    return loginResponse.data;
  } catch (error) {
    console.error('Erro fatal no loginInstance:', error.message);
    throw error;
  }
}
export default loginInstance;