# Línea base — Marcha blanca (2 programas piloto)

Snapshot del estado de estos 2 programas ANTES/AL INICIO del piloto del bot (arranque:
`2026-08-27`, ver `config.marchaBlancaStart`), para comparar contra las métricas que junte el
panel (`/dashboard`, sección "Marcha blanca por programa") una vez avance la marcha blanca.

Los campos con etiqueta clara vienen de la planilla operativa pegada por el usuario el
2026-08-27. La planilla trae MUCHAS columnas sin encabezado visible en el paste — donde el
significado no era inequívoco, se dejó la fila cruda tal cual en "Datos crudos sin etiquetar"
en vez de arriesgar una etiqueta incorrecta. Los valores `#N/A`, `#DIV/0!`, `#REF!` son errores
de fórmula de la planilla original, no datos reales — se mantienen tal cual para que quede
registro exacto de lo que había en ese momento.

## Diplomado en Inteligencia Artificial

| Campo | Valor |
|---|---|
| Código | DI-INT-073 |
| Código interno | DI185_413 |
| Facultad | Ingeniería |
| Duración | 5 meses |
| Modalidad | Online |
| Cohorte/año | 2026 |
| Estado | ACTIVO |
| Matrícula | $150.000 |
| Arancel de lista | $1.190.000 |
| Descuento institucional | 40% |
| Arancel con descuento | $714.000 |
| Total con descuento (matrícula + arancel c/dto) | $864.000 |
| Asesor Norte | Zaida Verdugo |
| Asesor Sur | Constanza Huitraiqueo Garabito |
| Estado de matrículas | Sin matrículas |
| Salud financiera | Tier 4 · 🟢 Saludable |
| Referencia histórica (título anterior) | [DI] Inteligencia artificial - 2024 |

**Cronograma de cohortes/salidas (al 2026-08-27):**
- Marzo — Con Flujo Cerrado (curso sello 23-03, curso 1: 25-03, inicio 01 de abril)
- Julio — Con Flujo Cerrado (curso sello 15-06, curso 1: 25-06, inicio 2 de julio) — carga de flujo "Pendiente de carga"
- Octubre — Flujo Solicitado (semana 12 de octubre)
- Octubre (otra salida) — Sin quorum mínimo

**Datos crudos sin etiquetar** (columnas cuyo significado no era inequívoco en el paste — se listan en el mismo orden en que llegaron, para no perder información):
```
Actualizado	4	0	0	160	0,0	0	Gráfica creada	Actualizado	Video por crear	No aplica	2.600	$3.436	$8.932.638	3176	$10.910.092	31-12-2026	Creada	$68.188	#REF!	680.000	No	Actualizada	No Actualizado	No Actualizado	No Actualizado	No Actualizado	Campaña no creada	Actualizado	No Actualizado	Actualizado	sin comentario	DI185_413	0	0	0	0	0	0	0	#N/A	160	1,42240	0,00%	0,00%	50%	40%	0	0	$5.283.296	$5.556.530	29/12/2025	28/12/2026	#DIV/0!	$67.998	#N/A	#N/A	Malo	#N/A	#DIV/0!	#N/A	$3.208	1.647	0,00%	#DIV/0!	-30,00%	48,74%	123	0,81	#DIV/0!	#DIV/0!	#DIV/0!	#DIV/0!
```

---

## Diplomado en Intervención Terapéutica Familiar

| Campo | Valor |
|---|---|
| Código | DI-INT-079 |
| Código interno | DI144_413 |
| Facultad | Ciencias de la Salud |
| Duración | 5 meses |
| Modalidad | Online |
| Cohorte/año | 2025 |
| Estado | ACTIVO |
| Matrícula | $150.000 |
| Arancel de lista | $1.090.000 |
| Descuento institucional | 40% |
| Arancel con descuento | $654.000 |
| Total con descuento (matrícula + arancel c/dto) | $804.000 |
| Asesor Norte | Joaquín Retamal |
| Asesor Sur | Eduardo Arias |
| Estado de matrículas | Sin matrículas |
| Salud financiera | Tier 1 · 🟢 Saludable |
| Referencia histórica (título anterior) | [2024] [DI] [Q3] Intervención Terapéutica Familiar |

**Cronograma de cohortes/salidas (al 2026-08-27):**
- Agosto — Sin quorum mínimo
- Octubre — Sin quorum mínimo
- (3 salidas adicionales sin flujo asignado)

**Datos crudos sin etiquetar:**
```
Actualizado	2	0	0	80	0,0	0	Gráfica creada	Actualizado	Video por crear	Video por crear	893	$8.000	$7.143.893	1401	$11.206.106	30-11-2026	Creada	$140.076	#REF!	680.000	Si	Actualizada	No Actualizado	No Actualizado	No Actualizado	No Actualizado	Actualizado	Actualizado	No Actualizado	No Actualizado	Actualizado	sin comentario	DI144_413	0	0	0	0	0	0	0	#N/A	80	0,00%	0,00%	50%	40%	0	0	$5.830.358	$5.302.444	29/12/2025	30/11/2026	#DIV/0!	$65.659	#N/A	#N/A	Malo	#N/A	#DIV/0!	#N/A	$4.566	1.277	1.161	0	174	0	795.367	#DIV/0!	0,00%	#DIV/0!	-30,00%	52,37%	95	1,05	#DIV/0!	#DIV/0!	#DIV/0!	#DIV/0!
```

---

## Notas

- Los precios (matrícula, arancel, descuento, total) coinciden exactamente con lo ya cargado en
  `src/core/condicionesComerciales.data.json` — no requirió actualización.
- Los nombres completos de asesores (Zaida Verdugo, Constanza Huitraiqueo Garabito, Joaquín
  Retamal, Eduardo Arias) reemplazan/enriquecen los nombres de pila usados en
  `config.marchaBlancaProgramas` (`src/config.ts`) para el panel.
