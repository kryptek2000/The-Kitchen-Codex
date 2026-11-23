/**
 * SINC-2R4 test bootstrap.
 *
 * The production server reads its signing private key from the environment. The
 * client trust anchor is a build-time constant. Tests use one fixed synthetic
 * key pair for both so the real server-signing -> browser-verification path is
 * exercised. These values are test-only and are never production credentials.
 */
import testKey from './fixtures/brandedTestKey.json';

process.env.USDA_BRANDED_SIGNING_PRIVATE_KEY = testKey.private_key_pkcs8_base64;
