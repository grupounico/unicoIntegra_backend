function limpar(texto) {
  return String(texto || "").replace(/\s+/g, " ").trim();
}

function protegerPontosNumericos(texto) {
  return texto.replace(/(\d)\.(\d)/g, "$1__PONTO__$2");
}

function restaurarPontosNumericos(texto) {
  return texto.replace(/__PONTO__/g, ".");
}

function titleCase(texto) {
  const manter = new Set(["mg", "mL", "mg/mL", "mg/g", "mcg", "g", "kg", "UI", "MFP", "A.I.", "OX"]);
  const minusculas = new Set(["de", "do", "da", "dos", "das", "e", "com", "para"]);

  return limpar(texto)
    .split(" ")
    .map((p, i) => {
      if (manter.has(p)) return p;
      if (/^\d/.test(p)) return p;
      // Dosagem composta (500+125MG, 10MG/20MG) fica intacta, mas um "+" ou
      // "/" colado numa palavra sem numero (+EXODUS) e so prefixo de nome de
      // produto - nao deve escapar do title case, senao fica gritando em
      // maiuscula por causa de um simbolo.
      if ((p.includes("/") || p.includes("+")) && /\d/.test(p)) return p;
      const prefixo = /^[+/]/.test(p) ? p.charAt(0) : "";
      const resto = prefixo ? p.slice(1) : p;
      const lower = resto.toLowerCase();
      if (i > 0 && minusculas.has(lower)) return prefixo + lower;
      return prefixo + resto.charAt(0).toUpperCase() + resto.slice(1).toLowerCase();
    })
    .join(" ")
    .replace(/\bMl\b/g, "mL")
    .replace(/\bMg\b/g, "mg")
    .replace(/\bMcg\b/g, "mcg")
    .replace(/\bKg\b/g, "kg")
    .replace(/\bG\b/g, "g")
    .replace(/\bAçucar\b/g, "Açúcar")
    .replace(/\bAcucar\b/g, "Açúcar")
    .replace(/\bRapida\b/g, "Rápida")
    .replace(/\bForca\b/g, "Força")
    .replace(/\bSensivel\b/g, "Sensível")
    .replace(/\bRecarregavel\b/g, "Recarregável")
    .replace(/\bLiquido\b/g, "Líquido")
    .replace(/\bSodico\b/g, "Sódico")
    .replace(/\bDermatologico\b/g, "Dermatológico")
    .replace(/\bDermatologica\b/g, "Dermatológica")
    .replace(/\bDrageas\b/g, "Drágeas")
    .replace(/\bCapsulas\b/g, "Cápsulas")
    .replace(/\bCapsula\b/g, "Cápsula")
    .replace(/\bPessego\b/g, "Pêssego")
    .replace(/\bMaca\b/g, "Maçã")
    .replace(/\bPiui\b/g, "Piuí")
    .replace(/\bImedia\b/g, "Imédia");
}

function contextoSuplemento(original) {
  const t = String(original || "").toUpperCase();
  if (/\b(CR|CRE|MASC)\.?\s*CAP\b/.test(t)) return false;
  return ["WHEY", "SH.MASS", "MASS SH", "MALTODEXTRIN", "BARRA PROT", "BAD BOY", "BEST WHEY", "NUTRI WHEY", "TOP WHEY"].some(p => t.includes(p));
}

function contextoFralda(original) {
  const t = String(original || '').toUpperCase();
  const comecaComoFralda = /^(FR|FD|FDR)[.\s]/.test(t) || t.startsWith('FD.') || t.startsWith('FDR.');
  if (!comecaComoFralda) return false;

  return [
    'HUGGIES', 'PAMPERS', 'SMILINGUIDO', 'VIC BABY', 'CLASSIC BABY',
    'DIGUIFRAL', 'ANJINHOS', 'BIGFRAL', 'BIOFRAL', 'BABYSEC',
    'BEBE FELIZ', 'BEBÊ FELIZ', 'POM POM', 'POMPOM', 'TENA', 'MILI',
    'BABY', 'FD.INF', 'GERIATR', 'GERI'
  ].some((p) => t.includes(p));
}

function normalizarUnidadesEQuantidades(texto) {
  let s = texto;

  // Dosagem composta com três números e unidade final: 300+35+50MG
  s = s.replace(/(\d+(?:,\d+)?)\+(\d+(?:,\d+)?)\+(\d+(?:,\d+)?)\s*MG\b/gi, '$1 mg + $2 mg + $3 mg');

  // Dosagem composta com segunda parte em concentração: 3MG+3MG/ML
  s = s.replace(/(\d+(?:,\d+)?)MG\+(\d+(?:,\d+)?)\s*MG\/ML\b/gi, '$1 mg + $2 mg/mL');

  // Dosagem composta com unidades nos dois lados: 1MG+0,250MG
  s = s.replace(/(\d+(?:,\d+)?)(MG|MCG|G|ML|UI)\+(\d+(?:,\d+)?)(MG|MCG|G|ML|UI)/gi, (_, a, ua, b, ub) => {
    const mapa = { MG: "mg", MCG: "mcg", G: "g", ML: "mL", UI: "UI" };
    return `${a} ${mapa[ua.toUpperCase()]} + ${b} ${mapa[ub.toUpperCase()]}`;
  });

  // Dosagem composta com unidade implícita: 500+125MG
  s = s.replace(/(\d+(?:,\d+)?)\+(\d+(?:,\d+)?)(MG|MCG|G|ML|UI)/gi, (_, a, b, u) => {
    const mapa = { MG: "mg", MCG: "mcg", G: "g", ML: "mL", UI: "UI" };
    const unidade = mapa[u.toUpperCase()];
    return `${a} ${unidade} + ${b} ${unidade}`;
  });

  s = s
    .replace(/(\d+(?:,\d+)?)MG\/ML/gi, "$1 mg/mL")
    .replace(/(\d+(?:,\d+)?)MG\/G/gi, "$1 mg/g")
    .replace(/(\d+(?:,\d+)?)MG\b/gi, "$1 mg")
    .replace(/(\d+(?:,\d+)?)MCG\b/gi, "$1 mcg")
    .replace(/(\d+(?:,\d+)?)ML\b/gi, "$1 mL")
    .replace(/(\d+(?:,\d+)?)KG\b/gi, "$1 kg")
    .replace(/(\d+(?:,\d+)?)GR\b/gi, "$1 g")
    .replace(/(\d+(?:,\d+)?)G\b/g, "$1 g")
    .replace(/(\d+(?:,\d+)?)K\b/gi, "$1 kg")
    .replace(/\b(\d+)CPR?\b/gi, "$1 Comprimidos")
    .replace(/\b(\d+)COMP\b/gi, "$1 Comprimidos")
    .replace(/\b(\d+)CAPS?\b/gi, "$1 Cápsulas")
    .replace(/\b(\d+)CPS\b/gi, "$1 Cápsulas")
    .replace(/\b(\d+)DRG\b|\b(\d+)DR\b/gi, (_, a, b) => `${a || b} Drágeas`)
    .replace(/\b(\d+)DOSES\b/gi, "$1 Doses")
    .replace(/\b(\d+)DOS\b/gi, "$1 Doses")
    .replace(/\b(\d+)UND?\b/gi, "$1 Unidades")
    .replace(/\b(\d+)SACHES?\b/gi, "$1 Sachês")
    .replace(/\b([\d.]*\d)\s*UII?\b/gi, "$1 UI")
    .replace(/C\/\s*(\d+)\s*\+\s*(\d+)/gi, "$1 + $2 Unidades")
    .replace(/C\/\s*(\d+)/gi, "$1 Unidades")
    .replace(/S\/AB/gi, "Sem Abas")
    .replace(/C\/AB/gi, "Com Abas")
    .replace(/C\/REF/gi, "Com Reforço")
    .replace(/C\/SUP/gi, "Com Suporte")
    .replace(/P\/MAQUIAGEM\b/gi, "Para Maquiagem")
    .replace(/P\/MAQUIAG\b/gi, "Para Maquiagem")
    .replace(/P\//gi, "Para ");

  return s;
}

function aplicarContextos(textoOriginal) {
  const original = String(textoOriginal || "").toUpperCase();
  let s = protegerPontosNumericos(original);

  // ponto vira separador, mas códigos tipo 8.3 ficam preservados
  s = s.replace(/[.]+/g, " ");
  s = restaurarPontosNumericos(s);

  // "+" colado numa letra e separador de nome (prefixo tipo "+EXODUS" ou
  // combinação "BANANA+ACAI"), nao dosagem - vira espaço aqui pra virar
  // palavra normal no title case. "+" entre digitos (500+125MG) fica
  // intacto pras regras de dosagem composta mais abaixo.
  s = s.replace(/\+(?=[A-ZÀ-Ú])/g, " ");

  if (contextoSuplemento(original)) {
    s = s
      .replace(/SH\s*MASS/gi, "Shake Mass")
      .replace(/MASS\s*SH/gi, "Mass Shake")
      .replace(/\bSH\b/gi, "Shake")
      .replace(/\bPROT\b/gi, "Protein")
      .replace(/\bPO\b/gi, "Pó")
      .replace(/\bBAU\b|\bBAUN\b|\bBAUNIL\b/gi, "Baunilha")
      .replace(/\bCHOC\b/gi, "Chocolate")
      .replace(/\bMOR\b|\bMORANG\b/gi, "Morango")
      .replace(/\bPESS\b/gi, "Pêssego")
      .replace(/BAN\/MA/gi, "Banana/Maçã")
      .replace(/\bBAN\b/gi, "Banana")
      .replace(/\bBAD BO\b|\bBAD BOY\b/gi, "Bad Boy")
      .replace(/\bATLHETIC\b|\bATLHET\b|\bATL\b/gi, "Atlhetica")
      .replace(/\bMALTODEXTRIN\b/gi, "Maltodextrina")
      .replace(/COOK&CR|CO\/CR/gi, "Cookies & Cream")
      .replace(/DOC LEIT/gi, "Doce de Leite")
      .replace(/\b(300|450|500|800|850|900|907|930)\b(?!\s*(g|mL|kg))/gi, "$1 g");
  }

  // Categorias e contextos gerais
  s = s
    .replace(/\bSH\b/gi, "Shampoo")
    .replace(/\bBRINQ\b/gi, "Brinquedo")
    .replace(/\bAPREND\b/gi, "Aprendizado")
    .replace(/\bCHUP\b/gi, "Chupeta")
    .replace(/\bAERO\b/gi, "Aerossol")
    .replace(/\bADES\b/gi, "Adesivos")
    .replace(/\bPO\b/gi, "Pó")
    .replace(/\bUND\b|\bUNID\b/gi, "Unidades")
    .replace(/\bSACHE\b/gi, "Sachê")
    .replace(/\bBISC\b/gi, "Biscoito")
    .replace(/\bCREM\b/gi, "Cremoso")
    .replace(/\bTRAT\b/gi, "Tratamento")
    .replace(/\bMAQ\b/gi, "Maquiagem")
    .replace(/\bDEPIL\b/gi, "Depilatório")
    .replace(/\bOFT\b/gi, "Oftálmico")
    .replace(/\bVAG\b/gi, "Vaginal")
    .replace(/\bMAST\b/gi, "Mastigável")
    .replace(/\bDEO\b/gi, "Desodorante")
    .replace(/\bHID\b/gi, "Hidratante")
    .replace(/\bAPAR\s+DEPIL\b/gi, "Aparelho Depilatório")
    .replace(/\bESC\s+DENT\b/gi, "Escova Dental")
    .replace(/\bESC\s+DT\b/gi, "Escova Dental")
    .replace(/\bESCOVA\s+DT\b/gi, "Escova Dental")
    .replace(/\bCREME\s+DT\b/gi, "Creme Dental")
    .replace(/\bESC\s+CAB\b/gi, "Escova para Cabelo")
    .replace(/\bESCOVA\s+(?:P\/?\s*)?CAB\b/gi, "Escova para Cabelo")
    .replace(/\bP\/?\s*CAB\b/gi, "Para Cabelo")
    .replace(/\bPROT\s+FPS\b/gi, "Protetor Solar FPS")
    .replace(/\bPROT\s+SOL\b/gi, "Protetor Solar")
    .replace(/\bAPAR\s+DEPILATÓRIO\b/gi, "Aparelho Depilatório")
    .replace(/\bCOL\s+(?=\d+(?:,\d+)?\s*MG|\d+\s*ML)/gi, "Colírio ")
    .replace(/\bPRES\s+(?=(?:OLLA|SKYN|BLOWTEX|JONATEX))/gi, "Preservativo ")
    .replace(/\b(\d+)\s+DRG\b/gi, "$1 Drágeas")
    .replace(/\bHIDRA\s+(?=(?:CERAMIDAS|VITAMINAS|HIALURONICO))/gi, "Hidratação ")
    .replace(/\bHID\s+FAC\b/gi, "Hidratante Facial")
    .replace(/\bCLAV\s+POTASSIO\b/gi, "Clavulanato de Potássio")
    .replace(/\bPROT\s+LAB\b/gi, "Protetor Labial")
    .replace(/\b(\d+)\s+APLIC\b/gi, "$1 Aplicadores")
    .replace(/\bFLAC\s+(?=\d+\s*ML)/gi, "Flaconete ")
    .replace(/\bFOSF\s+(?=[A-Z])/gi, "Fosfato ")
    .replace(/\bMAC\s+INST\b/gi, "Macarrão Instantâneo")
    .replace(/\bINST\b/gi, "Instantâneo")
    .replace(/\bFLUOR\b/gi, "Flúor")
    .replace(/\bAER\b/gi, "Aerossol")
    .replace(/\bDERM\b/gi, "Dermatológico")
    .replace(/\bCORP\b/gi, "Corporal")
    .replace(/\bCONC\b/gi, "Concentrado")
    .replace(/\bCINT\b/gi, "Cintilante")
    .replace(/\bANT\s+CAR\b/gi, "Anticáries")
    .replace(/\bANT\b(?=\s+(?:FRUTAS|FRESH|CLINICAL))/gi, "Antitranspirante")
    .replace(/\bSOL\b/gi, "Solução")
    .replace(/\bPROT\s+FPS(\d+)\b/gi, "Protetor Solar FPS$1")
    .replace(/\bPROT\s+PARA\s+PES\b/gi, "Protetor para Pés")
    .replace(/\bENV\b/g, "Envelope")
    .replace(/\bAPAR\s+(?=(?:BARBEAR|VENUS|MACH|PRESTOBARBA))/gi, "Aparelho ")
    .replace(/\bXarope\s+Ad\b/g, "Xarope Adulto")
    .replace(/\bAd\s+Spray\b/g, "Adulto Spray")
    .replace(/\bPRES\b/g, "Preservativo")
    .replace(/\bFac\b/g, "Facial")
    .replace(/\bMed\b/g, "Médio")
    .replace(/\bÓleo\s+Cab\b/g, "Óleo Capilar")
    .replace(/\bTratamento\s+Cab\b/g, "Tratamento Capilar")
    .replace(/\bBaby\s+Cab\b/g, "Baby Cabelos")
    .replace(/\bHidratante\s+Lab\b/g, "Hidratante Labial")
    .replace(/\bAcet\b/g, "Acetato")
    .replace(/\bMor\s+(?=(?:E|CIT|CHOC))/gi, "Morango ")
    .replace(/\bFr\b(?=\s+(?:\d|C\/?|GTS))/g, "Frasco")
    .replace(/\b(\d+)\s+Aplic\b/g, "$1 Aplicadores")
    .replace(/\bFlac\b/g, "Flaconete")
    .replace(/\bPes\s+Cal\b/g, "Pés Calcanhar")
    .replace(/\bFio\s+Dt\b/g, "Fio Dental")
    .replace(/\b(?:Cr|Creme|Gel)\s+Dt\b/g, (match) => match.replace(/Dt$/, "Dental"))
    .replace(/\bPolvilho\s+Ant\b/g, "Polvilho Antisséptico")
    .replace(/\b(\d+)\s+Unidades\s+Cp\b/g, "$1 Unidades Comprimidos")
    .replace(/\b(?:Onicut|Uniprazol)\s+Cap\b/g, (match) => match.replace(/Cap$/, "Cápsulas"))
    .replace(/\bMáscara\s+Filler\s+Cap\b/g, "Máscara Filler Capilar")
    .replace(/\bDrg\b/g, "Drágeas")
    .replace(/(\d+)%Desc\b/gi, "$1% Desconto")
    .replace(/\bCHOC\b/gi, "Chocolate")
    .replace(/\bDOCE\s+LEITE\b/gi, "Doce de Leite")
    .replace(/\bLIQ\b/gi, "Líquido")
    .replace(/\bCAPS\b|\bCPS\b/gi, "Cápsulas")
    .replace(/\bCOMPS?\b|\bCPR\b/gi, "Comprimidos")
    .replace(/\bABS\b/gi, "Absorvente")
    .replace(/\bMAMAD\b/gi, "Mamadeira")
    .replace(/\bREFRIG\b/gi, "Refrigerante")
    .replace(/\bBLOQ\b/gi, "Bloqueador")
    .replace(/\bELET\b/gi, "Elétrico")
    .replace(/\bINJ\b/gi, "Injetável")
    .replace(/\bAMP\b/gi, "Ampola")
    .replace(/\bINF\b/gi, "Infantil")
    .replace(/\bCOND\b/gi, "Condicionador")
    .replace(/\bSAB LIQ\b/gi, "Sabonete Líquido")
    .replace(/\bSAB\b/gi, "Sabonete")
    .replace(/\bDESOD\b|\bDES\b/gi, "Desodorante")
    .replace(/\bCR DENT\b/gi, "Creme Dental")
    .replace(/\bCR D\b|\bCRD\b/gi, "Creme Dental")
    .replace(/\bCR\b|\bCRE\b/gi, "Creme")
    .replace(/\bLOC\b/gi, "Loção")
    .replace(/\bENX BUC\b/gi, "Enxaguante Bucal")
    .replace(/\bESC DENT\b|\bESC D\b/gi, "Escova Dental")
    .replace(/\bCURAT\b|\bCUR\b/gi, "Curativo")
    .replace(/\bLENCOS\b/gi, "Lenços")
    .replace(/\bLENC\b/gi, "Lenço")
    .replace(/\bUMED\b|\bUME\b/gi, "Umedecidos")
    .replace(/\bTIN\b|\bTINT\b/gi, "Tintura")
    .replace(/\bALIS\b/gi, "Alisante")
    .replace(/\bDESCOL\b/gi, "Descolorante")
    .replace(/\bPOM DERM\b/gi, "Pomada Dermatológica")
    .replace(/\bPOM\b/gi, "Pomada")
    .replace(/\bCR DERM\b/gi, "Creme Dermatológico")
    .replace(/\bSPR\b/gi, "Spray")
    .replace(/\bGTS\b/gi, "Gotas")
    .replace(/\bXPE\b/gi, "Xarope")
    .replace(/\bSUSP\b/gi, "Suspensão")
    .replace(/\bGE\b/gi, "Genérico");

  s = s
    .replace(/\bPROT\s+SOLAR\b/gi, "Protetor Solar")
    .replace(/\bPROT\s+LABIAL\b/gi, "Protetor Labial")
    .replace(/\bPROT\s+FACIAL\b/gi, "Protetor Facial")
    .replace(/\bPROT\s+OCULAR\b/gi, "Protetor Ocular")
    .replace(/\bTRIP\s+PROT\b/gi, "Tripla Proteção")
    .replace(/\bSOL\s+INJ\b/gi, "Solução Injetável")
    .replace(/\bSOL\s+OFT\b/gi, "Solução Oftálmica")
    .replace(/\bCOMP\s+REV\b/gi, "Comprimidos Revestidos")
    .replace(/\bAGULHA\s+DESC\b/gi, "Agulha Descartável")
    .replace(/\bLENC[OOS]+\s+DESC\b/gi, "Lenços Descartáveis")
    .replace(/\bCREME\s+PENT\b/gi, "Creme para Pentear");

  // Expande conectores de apresentação somente após os formatos C/12 e S/AB.
  s = s
    .replace(/\bC\/(?=[A-Z])/gi, "Com ")
    .replace(/\bC\/\s+(?=[A-Z])/gi, "Com ")
    .replace(/\bS\/(?=[A-Z])/gi, "Sem ");

  if (original.includes("E.V.A") || original.includes("EVA")) {
    s = s.replace(/\bE\s+V\s+A\b/gi, "EVA");
  }

  if (/\b(COPO|MAMADEIRA|BICO|CHUPETA)\b/.test(original)) {
    s = s.replace(/\bMASC\b/gi, "Masculino");
  }

  if (/\b(DESOD|AERO|ANTITRANSPIRANTE|MEN|SPORT)\b/.test(original)) {
    s = s.replace(/\bMASC\b/gi, "Masculino");
  }

  // Marcas/linhas e abreviações contextuais recorrentes
  s = s
    .replace(/\bGILL\b|\bGIL\b/gi, "Gillette")
    .replace(/\bJOHNSONS\b/gi, "Johnson's")
    .replace(/\bMUND\b/gi, "Mundial")
    .replace(/\bCOLG\b/gi, "Colgate")
    .replace(/\bPALM\b/gi, "Palmolive")
    .replace(/\bPHYTOERV\b/gi, "Phytoervas")
    .replace(/\bPROMI\b|\bPROMIL\b/gi, "Promillus")
    .replace(/\bSORR\b/gi, "Sorriso")
    .replace(/\bFRESHM\b/gi, "Fresh Mint")
    .replace(/\bLV\b/gi, "Leve")
    .replace(/\bEXT\b/gi, "Extrato")
    .replace(/\bALG\b/gi, "Algas")
    .replace(/\bADOC\b/gi, "Adoçante")
    .replace(/\bCULINARIO\b/gi, "Culinário")
    .replace(/\bBOMB\b/gi, "Bomba")
    .replace(/\bTIRA LEITE\b/gi, "Tira-Leite")
    .replace(/\bCURV\b/gi, "Curva")
    .replace(/\bFIN\b/gi, "Fina")
    .replace(/\bRET\b/gi, "Reta")
    .replace(/\bNEOP\b/gi, "Neoprene")
    .replace(/\bMAC\b/gi, "Macia")
    .replace(/\bBAND AID\b/gi, "Band-Aid")
    .replace(/\bSIL\b/gi, "Silicone")
    .replace(/\bLAV\b/gi, "Lavável")
    .replace(/\bFUR\b/gi, "Furos")
    .replace(/\bSOD\b/gi, "Sódico")
    .replace(/\bCLOR\b/gi, "Cloridrato de")
    .replace(/\bFISIOGEL A I\b/gi, "Fisiogel A.I.")
    .replace(/\bALIV CALM\b/gi, "Alívio Calmante")
    .replace(/\bCETOC\+BETAM\b/gi, "Cetoconazol + Betametasona")
    .replace(/\bBETAM\+GENT\b/gi, "Betametasona + Gentamicina")
    .replace(/\bG DOUR\b/gi, "Gota Dourada")
    .replace(/\bPROT LEITE\b/gi, "Proteínas do Leite")
    .replace(/\bTR CHOQUE\b/gi, "Tratamento de Choque")
    .replace(/\bCAB SECO\b/gi, "Cabelos Secos")
    .replace(/\bCAB COLO\b/gi, "Cabelos Coloridos")
    .replace(/\bLONG STR\b/gi, "Long & Strong")
    .replace(/\bPROT MAMILO\b/gi, "Protetor de Mamilo")
    .replace(/\bPROT SEIOS\b/gi, "Protetor de Seios")
    .replace(/\bFIOR\b/gi, "Fiorucci")
    .replace(/\bAE\b/gi, "Aerossol")
    .replace(/\bECHA\b/gi, "Echarpe")
    .replace(/\bIMEDIA\b/gi, "Imédia")
    .replace(/\bALIC CUT\b/gi, "Alicate Cutícula")
    .replace(/\bINTERCAMB\b/gi, "Intercambiável");

  // Alguns contextos que dependem da frase inteira
  if (original.includes("BARRA CER")) s = s.replace(/BARRA CER/gi, "Barra de Cereal").replace(/\bCERAMIDAS\b/gi, "Cereal");
  if (original.includes("PROTEX") && /\bREF\b/.test(original)) s = s.replace(/\bREF\b|\bREFORÇO\b/gi, "Refil");
  if (original.includes("SAB PROTEX COMP 12")) s = s.replace(/COMP 12|COMPRIMIDO 12/gi, "Complete 12");
  if (/\b(CR|CRE|MASC)\s*CAP\b/.test(original)) s = s.replace(/\bCAP\b/gi, "Capilar").replace(/\bCÁPSULA\b/gi, "Capilar");
  if (original.includes("JOELHEIRA") || original.includes("NEOP")) {
    s = s
      .replace(/\bPAT\b/gi, "Patelar")
      .replace(/\bPATELAR\b/gi, "Patelar");
  }
  if (original.includes("ESC.D") && /40\s*G\s*MAC/.test(original)) s = s.replace(/40\s*g\s*Macia/gi, "40 Grande Macia");
  if (original.startsWith("COL.")) s = s.replace(/^COL\b/gi, "Colônia").replace(/\bPIUI\b/gi, "Piuí");
  if (original.startsWith("MAM KUKA")) s = s.replace(/\bRED\b/gi, "Redonda").replace(/\bCOL\b/gi, "Colorida").replace(/\bPL\b/gi, "Plástico");
  if (original.includes("PALM.NATURALS")) s = s.replace(/\bSECO\b/gi, "Cabelos Secos");




  if (contextoFralda(original)) {
    // Protege marcas antes de aliases genéricos: POM POM não é Pomada Pomada.
    s = s
      .replace(/\bPOM\s+POM\b/gi, 'Pom Pom')
      .replace(/\bPOMPOM\b/gi, 'Pom Pom')
      .replace(/^\s*FDR\b[.\s]*/gi, 'Fralda ')
      .replace(/^\s*FD\b[.\s]*/gi, 'Fralda ')
      .replace(/^\s*FR\b[.\s]*/gi, 'Fralda ')
      .replace(/\b(\d+)PX(\d+)FD\b/gi, '$1 Pacotes x $2 Fraldas')
      .replace(/\b(\d+)FD\b/gi, '$1 Fraldas')
      .replace(/\b(\d+)\s+Fardo\b/gi, '$1 Fraldas')
      .replace(/^\s*Fardo\b/gi, 'Fralda')
      .replace(/^\s*Frasco\b/gi, 'Fralda')
      .replace(/\bPomada\s+Pomada\b/gi, 'Pom Pom')
      .replace(/\bSUP\s+SEC\b/gi, 'Supersec')
      .replace(/\bSuporte\s+Secagem\b/gi, 'Supersec')
      .replace(/\bTot\s+Conforto\b/gi, 'Total Confort')
      .replace(/\bTrip\s+Pr\b/gi, 'Tripla Proteção')
      .replace(/\bConforto\s+Notur\b/gi, 'Conforto Noturno')
      .replace(/\bDia\s+Noi\b/gi, 'Dia e Noite')
      .replace(/\bSUP\s+CAR\b/gi, 'Supreme Care')
      .replace(/\bSuporte\s+Car\b/gi, 'Supreme Care')
      .replace(/\bVeste\s+Facial\b/gi, 'Veste Fácil')
      .replace(/\bRoup\b/gi, 'Roupinha')
      .replace(/\bU\s+Secagem\b/gi, 'Ultra Sec')
      .replace(/\bJumbi\b/gi, 'Jumbo');
  }



  if (original.startsWith('ESM ') || original.startsWith('ESM.')) {
    s = s.replace(/^\s*ESM\b/gi, 'Esmalte');
  }

  if (original.startsWith('MASC CAP') || original.includes(' MASC CAP ')) {
    s = s
      .replace(/^\s*MASC\s+CAP\b/gi, 'Máscara Capilar')
      .replace(/\bMasc\s+Capilar\b/gi, 'Máscara Capilar');
  }

  if (original.startsWith('CR PENT') || original.includes(' CR PENT ')) {
    s = s
      .replace(/^\s*CR\s+PENT\b/gi, 'Creme para Pentear')
      .replace(/\bCreme\s+Pent\b/gi, 'Creme para Pentear')
      .replace(/\bCreme\s+Pentear\b/gi, 'Creme para Pentear');
  }

  if (original.includes('MARU') && (original.includes('BAS CAS CAV') || original.includes('BAS.CAS.CAV'))) {
    s = s
      .replace(/\bBAS\b/gi, 'Base')
      .replace(/\bCAS\s+CAV\b/gi, 'Casco de Cavalo')
      .replace(/\bCastanho\s+Cav\b/gi, 'Casco de Cavalo');
  }

  if (original.includes('SFERA') && original.includes('DESM FIOS')) {
    s = s
      .replace(/\bDesm\s+Fios\b/gi, 'Desmaia Fios')
      .replace(/\bMascara\s+Capsula\b/gi, 'Máscara Capilar')
      .replace(/\bMáscara\s+Cápsula\b/gi, 'Máscara Capilar')
      .replace(/\bCreme\s+Pentear\b/gi, 'Creme para Pentear');
  }

  if (original.startsWith('TERM.CLIN') || original.startsWith('TERM CLIN')) {
    s = s
      .replace(/^\s*Term\s+Clin\b/gi, 'Termômetro Clínico')
      .replace(/\bBd\b/g, 'BD');
  }

  if (original.startsWith('DILTOR CD')) {
    s = s.replace(/\bCd\b/g, 'CD');
  }

  if (original.startsWith('POLIPRED COL')) {
    s = s.replace(/\bCol\b/gi, 'Colírio');
  }



  if (original.includes('JOAO&MAR') || original.includes('JOAO MAR')) {
    s = s
      .replace(/\bJoao\s+E\s+Mar\b/gi, 'João e Maria')
      .replace(/\bJOAO\s+MAR\b/gi, 'João e Maria')
      .replace(/\bGlic\b/gi, 'Glicerina');
  }

  if (original.includes('TIO NACHO') && original.includes('ANTIC')) {
    s = s.replace(/\bAntic\b/gi, 'Antiqueda');
  }

  if (original.startsWith('AP NEB') || original.includes(' G-TECH INAL')) {
    s = s
      .replace(/^\s*Ap\s+Neb\b/gi, 'Aparelho Nebulizador')
      .replace(/\bG\s+Tech\b/gi, 'G-Tech')
      .replace(/\bInal\b/gi, 'Inalador');
  }

  if (original.includes('GARNIER') && original.includes('HIAL PREEN')) {
    s = s
      .replace(/\bHial\s+Preen\b/gi, 'Hialurônico Preenchedor')
      .replace(/\bHID\s+FAC\b/gi, 'Hidratante Facial');
  }

  if (original.includes('ESM COLOR CINT')) {
    s = s
      .replace(/\bColor\b/gi, 'Colorama')
      .replace(/\bCint\b/gi, 'Cintilante');
  }

  if (original.includes('URNA ACRILICO')) {
    s = s
      .replace(/\bAcrilico\b/gi, 'Acrílica')
      .replace(/\bCaixa\s+Su\b/gi, 'Caixa Sugestão');
  }

  if (original.includes('NOSEWASH')) {
    s = s
      .replace(/\bNosewash\b/gi, 'NoseWash')
      .replace(/\bLavavel\s+Hel\b/gi, 'Lavagem Nasal')
      .replace(/\bLav\s+Hel\b/gi, 'Lavagem Nasal');
  }

  if (original.includes('DOVE')) {
    s = s
      .replace(/\bAcn\s+Con\b/gi, 'Acne Control')
      .replace(/\bGl\s+Fer\b/gi, 'GL + FER')
      .replace(/\bGL\s+FER\b/gi, 'GL + FER');
  }


  if (original.startsWith('OLEO CAP') || original.includes(' OLEO CAP ')) {
    s = s
      .replace(/Oleo\s+Cap/gi, 'Óleo Capilar')
      .replace(/Óleo\s+Cap/gi, 'Óleo Capilar');
  }

  if (original.includes('DOCTOR DUCK')) {
    s = s
      .replace(/\bInf\b/gi, 'Infantil')
      .replace(/\bINF\b/gi, 'Infantil');
  }

  if (original.includes('PANTENE')) {
    s = s
      .replace(/\bCOR\s+RAD\b|\bCor\s+Rad\b/gi, 'Cor Radiante')
      .replace(/\bHIDRAT\b|\bHidrat\b/gi, 'Hidratação')
      .replace(/\bCUID\s+CLAS\b|\bCuid\s+Clas\b|\bCuid\s+Classico\b/gi, 'Cuidado Clássico')
      .replace(/\bCUID\s+CL\b|\bCuid\s+Cl\b/gi, 'Cuidado Clássico')
      .replace(/\bLIS\s+SEDOS\b|\bLis\s+Sedos\b|\bLiso\s+Sedos\b/gi, 'Liso e Sedoso')
      .replace(/\bCAC\s+DEFIN\b|\bCac\s+Defin\b|\bCachos\s+Defin\b/gi, 'Cachos Definidos')
      .replace(/\b2X1\b|\b2\s+X\s+1\b/gi, '2 em 1')
      .replace(/\bREST\s+PROFUNDA\b|\bRest\s+Profunda\b/gi, 'Restauração Profunda')
      .replace(/\bLIS\s+EXT\b|\bLis\s+Ext\b|\bLis\s+Extrato\b|\bLiso\s+Ext\b/gi, 'Liso Extremo');
  }

  if (original.includes('ALIC.CUT') || original.includes('ALIC CUT')) {
    s = s
      .replace(/\bAlicate\s+Cutícula\b/gi, 'Alicate de Cutícula')
      .replace(/\bCom\s+1\b/gi, '1 Unidade');
  }


  if (original.includes('MANT.KARITE') || original.includes('MANT KARITE') || original.includes('MANT.KAR') || original.includes('MANT KAR')) {
    s = s
      .replace(/\bMANT\s+KARITE\b/gi, 'Manteiga de Karité')
      .replace(/\bMANT\s+KAR\b/gi, 'Manteiga de Karité')
      .replace(/\bMant\s+Karite\b/gi, 'Manteiga de Karité')
      .replace(/\bMant\s+Kar\b/gi, 'Manteiga de Karité');
  }

  if (original.includes('KARITE')) {
    s = s.replace(/\bKARITE\b/gi, 'Karité').replace(/\bKarite\b/gi, 'Karité');
  }

  if (original.includes('MARU')) {
    s = s
      .replace(/\bTRAT\b/gi, 'Tratamento')
      .replace(/\bTrat\b/gi, 'Tratamento')
      .replace(/\bBAS\b/gi, 'Base')
      .replace(/\bBas\b/gi, 'Base')
      .replace(/\bEND\b/gi, 'Endurecedor')
      .replace(/\bEnd\b/gi, 'Endurecedor')
      .replace(/\bFOR\b/gi, 'Fortalecedora')
      .replace(/\bCas\s+Cav\b/gi, 'Casco de Cavalo')
      .replace(/\bCASTANHO\s+CAV\b/gi, 'Casco de Cavalo')
      .replace(/\bCastanho\s+Cav\b/gi, 'Casco de Cavalo')
      .replace(/\bCAS\b/gi, 'Casco')
      .replace(/\bCastanho\b/gi, 'Casco');
  }

  if (original.includes('G.DOUR') || original.includes('G DOUR')) {
    s = s
      .replace(/\bG\s+Dour\b/gi, 'Gota Dourada')
      .replace(/\bTR\s+Fruit\b/gi, 'Tropical Fruit')
      .replace(/\bTropic\s+Fruit\b/gi, 'Tropical Fruit')
      .replace(/\bCresp\b/gi, 'Crespos');
  }

  if (original.includes('PROT.LEITE') || original.includes('PROT LEITE')) {
    s = s.replace(/\bProt\s+Leite\b/gi, 'Proteínas do Leite');
  }

  if (original.startsWith('ROC ')) {
    s = s
      .replace(/\bROC\b/gi, 'RoC')
      .replace(/\bMINENSOL\b/gi, 'Minesol')
      .replace(/\bBLOQ\b/gi, 'Bloqueador')
      .replace(/\bFP(\d+)\b/gi, 'FPS $1')
      .replace(/\bFPS(\d+)\b/gi, 'FPS $1')
      .replace(/\bCR\b/gi, 'Creme')
      .replace(/\bRETIN OX\b/gi, 'Retin-OX')
      .replace(/\bA WRINKLE\b/gi, 'Anti-Wrinkle');
  }

  if (original.includes('VIT.NIELY') || original.includes('VIT NIELY')) {
    s = s
      .replace(/\bVIT\b/gi, 'Vitamina')
      .replace(/\bANTI CASPA\b/gi, 'Anticaspa')
      .replace(/\bMANT KARITE\b/gi, 'Manteiga de Karité')
      .replace(/\bKARITE\b/gi, 'Karité');
  }

  s = normalizarUnidadesEQuantidades(s);
  s = titleCase(s);

  s = s
    .replace(/(\d{2,4})M\b/g, '$1 mL')
    .replace(/\s*\/\s*$/g, '')
    .replace(/1 Unidades/g, '1 Unidade')
    .replace(/Band-aid/g, 'Band-Aid')
    .replace(/\bRoc\b/g, 'RoC')
    .replace(/\bFps\b/g, 'FPS')
    .replace(/\bXg\b/g, 'XG')
    .replace(/\bXxg\b/g, 'XXG')
    .replace(/\bEg\b/g, 'EG')
    .replace(/\bRn\b/g, 'RN')
    .replace(/\bRecem-nascido\b/g, 'Recém-Nascido')
    .replace(/\bTira-leite\b/g, 'Tira-Leite')
    .replace(/\bCd\b/g, 'CD')
    .replace(/\bBd\b/g, 'BD')
    .replace(/\bBas\b/g, 'Base')
    .replace(/\bKarite\b/g, 'Karité')
    .replace(/\bClassico\b/g, 'Clássico')
    .replace(/\bEsm\b/g, 'Esmalte')
    .replace(/\bMasc\b/g, 'Máscara')
    .replace(/\bEva\b/g, 'EVA')
    .replace(/\bFps(\d+)\b/g, 'FPS$1')
    .replace(/\bGuarana\b/g, 'Guaraná')
    .replace(/\bAlcool\b/g, 'Álcool')
    .replace(/\bOleo\b/g, 'Óleo')
    .replace(/\b(\d+) Unidades Un\b/g, '$1 Unidades')
    .replace(/\bComprimidos Rev\b/g, 'Comprimidos Revestidos')
    .replace(/\bSol Injetável\b/g, 'Solução Injetável')
    .replace(/\bSol Oft\b/g, 'Solução Oftálmica')
    .replace(/Óleo Cap\b/g, 'Óleo Capilar')
    .replace(/\b(Creme|T[oó]nico|Máscara|Manteiga|Modelador|Tinta|S[eé]rum|Geleia|Proteina) Cap\b/g, '$1 Capilar')
    .replace(/\b(\d+) Unidades Cap\b/g, '$1 Unidades Cápsulas')
    .replace(/\bOftam\b/g, 'Oftálmico')
    .replace(/\bMascara\b/g, 'Máscara')
    .replace(/\b(\d+)%\s*Desc\b/g, '$1% Desconto')
    .replace(/\bSilic\b/g, 'Silicone')
    .replace(/\bFem\b/g, 'Feminino')
    .replace(/\bAlca\b/g, 'Alça')
    .replace(/\bLocao\b/g, 'Loção')
    .replace(/\bLimao\b/g, 'Limão')
    .replace(/\bAgua\b/g, 'Água')
    .replace(/\bLapis\b/g, 'Lápis')
    .replace(/\bLenco\b/g, 'Lenço')
    .replace(/\bRacao\b/g, 'Ração')
    .replace(/\bCalca\b/g, 'Calça')
    .replace(/\bMaos\b/g, 'Mãos')
    .replace(/\bAcido\b/g, 'Ácido')
    .replace(/\bMedio\b/g, 'Médio')
    .replace(/\bPos\b/g, 'Pós')
    .replace(/\bBebe\b/g, 'Bebê')
    .replace(/\b(\d+)\s+Cap\b/g, '$1 Cápsulas')
    .replace(/\bCp\s+Rev\b/g, 'Comprimidos Revestidos')
    .replace(/\bSol\s+Cap\b/g, 'Solução Capilar')
    .replace(/\bCirurg\b/g, 'Cirúrgica')
    .replace(/\bElasti\b/g, 'Elástico')
    .replace(/\bDesc\b/g, 'Descartável')
    .replace(/(\d+)%Desc\b/g, '$1% Desconto')
    .replace(/\bAcet\b/g, 'Acetato')
    .replace(/\bDrg\b/g, 'Drágeas')
    .replace(/\bFr\b(?=\s+(?:\d|C\/|Gotas))/g, 'Frasco')
    .replace(/\bFac\b/g, 'Facial')
    .replace(/\bHidratante\s+Lab\b/g, 'Hidratante Labial')
    .replace(/\bÓleo\s+Cab\b/g, 'Óleo Capilar')
    .replace(/\bTratamento\s+Cab\b/g, 'Tratamento Capilar')
    .replace(/\b(?:Creme|Gel|Fio)\s+Dt\b/g, (match) => match.replace(/Dt$/, 'Dental'))
    .replace(/\bApar\s+Depilatorio\b/g, 'Aparelho Depilatório')
    .replace(/\bAparelho\s+Depilatório\s+Depilatório\b/g, 'Aparelho Depilatório')
    .replace(/\bApar\s+Pressao\b/g, 'Aparelho de Pressão')
    .replace(/\bProt\s+Mamilos\b/g, 'Protetor de Mamilos')
    .replace(/\b(?:Shampoo|Condicionador|Óleo|Tratamento)\s+Cab\b/g, (match) => match.replace(/Cab$/, 'Cabelo'))
    .replace(/\bBaby\s+Cab\b/g, 'Baby Cabelos')
    .replace(/(?:\+|\bCom)\s+Aplic\b/g, (match) => match.replace(/Aplic$/, 'Aplicador'))
    .replace(/\bFlac\b/g, 'Flaconete')
    .replace(/\b(\d+)\s+Unidades\s+Cp\b/g, '$1 Unidades Comprimidos')
    .replace(/\bHidratante\s+Fac\b/g, 'Hidratante Facial')
    .replace(/\bPolvilho\s+Ant\b/g, 'Polvilho Antisséptico')
    .replace(/\bSolução\s+Cap\b/g, 'Solução Capilar')
    .replace(/\bUniprazol\s+Cap\b/g, 'Uniprazol Cápsulas')
    .replace(/\b(?:Lar|Laranja)\s+Mor\b/g, 'Laranja Morango')
    .replace(/\bXarope\s+Ad\b/g, 'Xarope Adulto')
    .replace(/\bApar\b/g, 'Aparelho')
    .replace(/\bLouroc?\s+Esc\b/g, (match) => match.replace(/Esc$/, 'Escuro'))
    .replace(/\bCast\s+Esc\b/g, 'Castanho Escuro')
    .replace(/\bEsc\s+Mamad\b/g, 'Escova de Mamadeira')
    .replace(/\bEsc\s+Mamadeira\b/g, 'Escova de Mamadeira')
    .replace(/\bKit\s+Esc\b/g, 'Kit Escova')
    .replace(/\b(?:Louro|Marrom|Bege)\s+Med\b/g, (match) => match.replace(/Med$/, 'Médio'))
    .replace(/\bMed\s+Abrasao\b/g, 'Média Abrasão')
    .replace(/\b(?:Shampoo|Condicionador|Máscara|Creme|Pomada|Elastico|Ref)\s+Cab\b/g, (match) => match.replace(/Cab$/, 'Capilar'))
    .replace(/\bP\/\s*Aplic\b/g, 'Para Aplicação')
    .replace(/\bPara\s+Aplic\b/g, 'Para Aplicação')
    .replace(/\b(?:Caneta|Com|\+)\s+Aplic\b/g, (match) => match.replace(/Aplic$/, 'Aplicador'))
    .replace(/\b(?:Clinical|Men|Rexona)\s+Ant\b/g, (match) => match.replace(/Ant$/, 'Antitranspirante'))
    .replace(/\bProt(?=\s+(?:Max|Barra|Crisp|Bold))/g, 'Protein')
    .replace(/\bFralda\s+([\p{L}]+)\s+Prot\b/gu, 'Fralda $1 Proteção')
    .replace(/\bAlways\s+(?:S\s+)?Prot\s+Diario\b/g, 'Always Proteção Diária')
    .replace(/\bXarope\s+Ad\b/g, 'Xarope Adulto')
    .replace(/\bEsc\s+(?=\d+\s*mg)/gi, 'Escitalopram ')
    .replace(/\bEsc\s+Cilios\b/g, 'Escova de Cílios')
    .replace(/\bEsc\s+Macia\b/g, 'Escova Macia')
    .replace(/\b(?:Louro|Castanho|Marrom)\s+Med\b/g, (match) => match.replace(/Med$/, 'Médio'))
    .replace(/\bMed\s+Abrasao\b/g, 'Média Abrasão')
    .replace(/\b(?:Creme|Shampoo|Condicionador|Geleia|Máscara)\s+Cab\b/g, (match) => match.replace(/Cab$/, 'Capilar'))
    .replace(/\b(?:Tioconazol\s+Tinidazol.*|Fentizol.*|Ultraproct.*)\s+Aplic\b/g, (match) => match.replace(/Aplic$/, 'Aplicador'))
    .replace(/\bPinceis\s+Aplic\b/g, 'Pincéis Aplicadores')
    .replace(/\bPincel\s+[^+]*\s+Para\s+Aplic\b/g, (match) => match.replace(/Aplic$/, 'Aplicação'))
    .replace(/\b(?:Dori|Disqueti|Deliket).*\s+Conf\b/g, (match) => match.replace(/Conf$/, 'Confeitos'))
    .replace(/\bReach\s+Conf\b/g, 'Reach Conforto')
    .replace(/\bCaderno\s+Esp\b/g, 'Caderno Espiral')
    .replace(/\bEsp\s+Nexcare\b/g, 'Esparadrapo Nexcare')
    .replace(/\bEsp\s+Impermeavel\b/g, 'Esparadrapo Impermeável')
    .replace(/\b(?:Colorama|Nestle|Tratamento)\s+Esp\b/g, (match) => match.replace(/Esp$/, 'Especial'))
    .replace(/\bNail\s+Enc\b/g, 'Nail Encaixe')
    .replace(/\b(?:Onicut|Uniprazol)\s+Cap\b/g, (match) => match.replace(/Cap$/, 'Cápsulas'))
    .replace(/\bMáscara\s+Filler\s+Cap\b/g, 'Máscara Filler Capilar')
    .replace(/\b(?:Creme|Hidrat)\s+Lab\b/g, (match) => match.replace(/Lab$/, 'Labial'))
    .replace(/\b(?:C\/\s*\d+|\d+)\s+Fr\b/g, (match) => match.replace(/Fr$/, 'Frasco'))
    .replace(/\b(\d+)\s+Unidades\s+Fr\b/g, '$1 Unidades Frasco')
    .replace(/\bFr\s+Vermelhas\b/g, 'Frutas Vermelhas')
    .replace(/\bFr\s+Amarelas\b/g, 'Frutas Amarelas')
    .replace(/\bProt\s+Para\s+Pes\b/g, 'Protetor para Pés')
    .replace(/\bCom\s+Prot\b/g, 'Com Protetor')
    .replace(/\bApar\+(?=\d|Refil)/gi, 'Aparelho + ')
    .replace(/\bFr\s*\+\s*Dil\b/gi, 'Frasco + Diluente')
    .replace(/\bFr\s+Dil\b/gi, 'Frasco com Diluente')
    .replace(/\bCr\s+Fr\s+Ct\b/g, 'Creme Frasco Ct')
    .replace(/\bCap\s+Blx\b/g, 'Cápsulas Blx')
    .replace(/\bKit\s+Esp\b/g, 'Kit Especial')
    .replace(/\bTratamento\s+Esp\b/g, 'Tratamento Especial')
    .replace(/\b(\d+)\s+mL\s+Esp\b/g, '$1 mL Espiral')
    .replace(/\bCuid Clas\b/g, 'Cuidado Clássico')
    .replace(/\bLis Sedos\b/g, 'Liso e Sedoso')
    .replace(/\bCac Defin\b/g, 'Cachos Definidos')
    .replace(/\bLis Extrato\b/g, 'Liso Extremo')
    .replace(/\b2X1\b/g, '2 em 1')
    .replace(/\b2 Em 1\b/g, '2 em 1')
    .replace(/Pacotes X/g, 'Pacotes x')
    .replace(/__MARCA_POMPOM__/g, 'Pom Pom')
    .replace(/\bPomada\s+Pomada\b/g, 'Pom Pom')
    .replace(/\bKg\b/g, 'kg')
    .replace(/\bUnidade Unidade\b/g, 'Unidade')
    .replace(/\b(\d+) Unidade Unidade\b/g, '$1 Unidade')
    .replace(/\bBand Aid\b/g, 'Band-Aid')
    .replace(/\bBand-aid\b/g, 'Band-Aid')
    .replace(/\bPomada Dermatológico\b/g, 'Pomada Dermatológica')
    .replace(/\bColirio\b/g, 'Colírio')
    .replace(/João&mar/gi, 'João e Maria')
    .replace(/Joao&mar/gi, 'João e Maria')
    .replace(/\bJoao\b/g, 'João')
    .replace(/\bg-tech\b/gi, 'G-Tech')
    .replace(/\bNosewash\b/g, 'NoseWash')
    .replace(/\bLavável\s+Hel\b/g, 'Lavagem Nasal')
    .replace(/\bLavavel\s+Hel\b/g, 'Lavagem Nasal')
    .replace(/\bKit\s+Fr\b/g, 'Kit Frasco')
    .replace(/\bFr\s+(\d+ mL)\b/g, 'Frasco $1')
    .replace(/\bOleo Cap\b/g, 'Óleo Capilar')
    .replace(/\bRep\s+GL\s+FER\b/gi, 'Reparador GL + FER')
    .replace(/\bReparador\s+GL\s+FER\b/gi, 'Reparador GL + FER')
    .replace(/\bRep\s+Gl\s+Fer\b/g, 'Reparador GL + FER')
    .replace(/\bRep\s+Gl\s+\+\s+Fer\b/g, 'Reparador GL + FER')
    .replace(/\bReparador\s+Gl\s+Fer\b/g, 'Reparador GL + FER')
    .replace(/\bNas\s+Ped\b/g, 'Nasal Pediátrico')
    .replace(/\bGotas\s+Nasal\b/g, 'Gotas Nasais')
    .replace(/\bVit\s+Skafe\b/g, 'Vitamina Skafe')
    .replace(/(\d+ mL)\/(\d+)\b/g, '$1 $2 Unidades')
    .replace(/\bGotas Nasais Pediátrico\b/g, 'Gotas Nasais Pediátricas')
    .replace(/\+HIDRO\b/g, 'Hidro')
    .replace(/\+([A-Za-zÁÉÍÓÚÂÊÔÃÕÇáéíóúâêôãõç])/g, ' $1');

  if (contextoFralda(original)) {
    s = s
      .replace(/\bPacotao\b/g, 'Pacotão')
      .replace(/\bAd\b/g, 'Adulto')
      .replace(/\bRn\b/g, 'RN')
      .replace(/\bXg\b/g, 'XG')
      .replace(/\bXxg\b/g, 'XXG')
      .replace(/\bEg\b/g, 'EG')
      .replace(/\bp\b/g, 'P')
      .replace(/\bm\b/g, 'M')
      .replace(/\bg\b/g, 'G');
  }

  if (original.includes('DOVE') && original.includes('GL+FER')) {
    s = s
      .replace(/\bOleo Cap\b/g, 'Óleo Capilar')
    .replace(/\bRep\s+GL\s+FER\b/gi, 'Reparador GL + FER')
      .replace(/\bReparador\s+GL\s+FER\b/gi, 'Reparador GL + FER');
  }

  // These replacements must run after title case so later context rules
  // cannot reintroduce abbreviated display names.
  s = s
    .replace(/\bProt\s+para\s+Pes\b/g, 'Protetor para Pés')
    .replace(/\bApar\+(?=\d|Refil)/g, 'Aparelho + ')
    .replace(/\bFr\s*\+\s*Dil\b/g, 'Frasco + Diluente')
    .replace(/\bCap\s+Blx\b/g, 'Cápsulas Blx')
    .replace(/\bUniprazol\s+\d+ mg\s+Cap\b/g, (match) => match.replace(/Cap$/, 'Cápsulas'))
    .replace(/\bEsc\s+Mamadeira\b/g, 'Escova de Mamadeira')
    .replace(/\bPara\s+Aplic\b/gi, 'Para Aplicação');

  if (/(?:MG|MCG)\/ML\s+COL\b|\bCOL\s+GTS\b/.test(original)) {
    s = s.replace(/\bCol\b/gi, 'Colírio');
  }

  s = s
    .replace(/\b(\d+)\s+Unidade\s+Fr\s+Dil\b/gi, '$1 Unidade Frasco com Diluente')
    .replace(/\bHidrat\s+Lab\b/gi, 'Hidratante Labial')
    .replace(/\bCreme\s+Lab\b/gi, 'Creme Labial')
    .replace(/\b(\d+)\s+g\s+Aplic\b/gi, '$1 g Aplicador')
    .replace(/\bCanetas?\s+Aplic\b/gi, 'Canetas Aplicadoras');

  s = s
    .replace(/\bProt\s+de\s+Mamilos\b/gi, 'Protetor de Mamilos')
    .replace(/\bProt\s+Pele\b/gi, 'Protetor de Pele')
    .replace(/\bProt\s+Baby\b/gi, 'Protetor Baby')
    .replace(/\bProt\s+Face\b/gi, 'Protetor Facial')
    .replace(/\bProt\s+Cerdas\b/gi, 'Protetor de Cerdas')
    .replace(/\bProt\s+do\s+Leite\b/gi, 'Proteínas do Leite')
    .replace(/\bProt\s+Diario\b/gi, 'Proteção Diária')
    .replace(/\bProt\s+Sec(?:a|o)?\b/gi, 'Proteção Seca')
    .replace(/\bProt\s+Flex\b/gi, 'Proteção Flex')
    .replace(/\bInt\s+Prot\b/gi, 'Proteção Intensa')
    .replace(/\bMen\s+Prot\s+Intensa\b/gi, 'Men Proteção Intensa')
    .replace(/\bProt\s+Epica\b/gi, 'Proteção Épica')
    .replace(/\bProt\s+(?=(?:Max|Integ|Absolut)\b)/gi, 'Protein ');

  if (original.includes('CADERNO')) {
    s = s
      .replace(/\b(\d+) mL\b/g, '$1 Matérias')
      .replace(/\bEsp\b/g, 'Espiral');
  }

  return limpar(s);
}

export function preNormalizarProduto(produto) {
  return aplicarContextos(produto);
}
