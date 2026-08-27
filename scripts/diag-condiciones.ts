import { buscarCondiciones } from '../src/core/condicionesComerciales';

const programa = process.argv[2] || 'Magíster en Inteligencia Artificial';
console.log(JSON.stringify(buscarCondiciones(programa), null, 2));
