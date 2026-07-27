import mysql from 'mysql2/promise';
import { normalizeEan } from '../utils/ean.js';
import { pickFirstString } from '../utils/text.js';

function mapAutomatizaProduct(row, index) {
  const id = Number(row?.product_id);
  const nome = pickFirstString(row?.title);

  return {
    id_produto: Number.isFinite(id) ? id : index,
    nome,
    nomeOriginal: nome,
    codigoBarras: normalizeEan(row?.ean),
    nomeLaboratorio: pickFirstString(row?.laboratorio),
    nomePrincipioAtivo: null,
    produtoOrigem: row,
  };
}

export class AutomatizaProductsClient {
  constructor({
    host = '',
    port = 3306,
    database = '',
    user = '',
    password = '',
    shopId = null,
    pageSize = 500,
  } = {}) {
    this.host = String(host || '').trim();
    this.port = Number.parseInt(port, 10) || 3306;
    this.database = String(database || '').trim();
    this.user = String(user || '').trim();
    this.password = String(password || '');
    this.shopId = Number.parseInt(shopId, 10) || 0;
    this.pageSize = Math.max(1, Number.parseInt(pageSize, 10) || 500);
  }

  validateConfiguration() {
    if (!this.host || !this.database || !this.user || !this.password || !this.shopId) {
      throw new Error('Configuracao da Automatiza incompleta. Informe host, database, user, password e shopId.');
    }
  }

  describeSource() {
    return `automatiza-mysql://${this.host}:${this.port}/${this.database}#shop-${this.shopId}`;
  }

  async fetchAllProducts() {
    this.validateConfiguration();

    const connection = await mysql.createConnection({
      host: this.host,
      port: this.port,
      database: this.database,
      user: this.user,
      password: this.password,
      connectTimeout: 30_000,
    });

    try {
      // The source view is slow. One complete read is materially faster than
      // paginating with OFFSET, which repeatedly re-evaluates the same view.
      const [rows] = await connection.execute(
        `select
           product_id, ean, title, Description, shop_id, price, price_promo,
           quantity, category, \`group\`, subgroup, brand, image_link, ncm,
           laboratorio, drug_is_generic, retencaoreceita
         from view_unicocontato_produto
         where shop_id = ?
           and ean is not null
           and trim(ean) <> ''
           and title is not null
           and trim(title) <> ''
         order by product_id`,
        [this.shopId],
      );

      return rows.map(mapAutomatizaProduct);
    } finally {
      await connection.end();
    }
  }
}
