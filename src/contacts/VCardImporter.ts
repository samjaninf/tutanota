import type { Contact, ContactAddress, ContactMailAddress, ContactPhoneNumber, ContactSocialId } from "../api/entities/tutanota/TypeRefs.js"
import {
	Birthday,
	createBirthday,
	createContact,
	createContactAddress,
	createContactMailAddress,
	createContactPhoneNumber,
	createContactSocialId,
} from "../api/entities/tutanota/TypeRefs.js"
import { ContactAddressType, ContactPhoneNumberType, ContactSocialType } from "../api/common/TutanotaConstants"
import { decodeBase64, decodeQuotedPrintable } from "@tutao/tutanota-utils"
import { birthdayToIsoDate, isValidBirthday } from "../api/common/utils/BirthdayUtils"
import { ParsingError } from "../api/common/error/ParsingError"
import { assertMainOrNode } from "../api/common/Env"

assertMainOrNode()

/**
 * split file content with multiple vCards into a list of vCard strings
 * @param vCardFileData
 */
export function vCardFileToVCards(vCardFileData: string): string[] | null {
	let V4 = "\nVERSION:4.0"
	let V3 = "\nVERSION:3.0"
	let V2 = "\nVERSION:2.1"
	let B = "BEGIN:VCARD\n"
	let E = "END:VCARD"
	vCardFileData = vCardFileData.replace(/begin:vcard/g, "BEGIN:VCARD")
	vCardFileData = vCardFileData.replace(/end:vcard/g, "END:VCARD")
	vCardFileData = vCardFileData.replace(/version:2.1/g, "VERSION:2.1")

	if (
		vCardFileData.indexOf("BEGIN:VCARD") > -1 &&
		vCardFileData.indexOf(E) > -1 &&
		(vCardFileData.indexOf(V4) > -1 || vCardFileData.indexOf(V3) > -1 || vCardFileData.indexOf(V2) > -1)
	) {
		vCardFileData = vCardFileData.replace(/\r/g, "")
		vCardFileData = vCardFileData.replace(/\n /g, "") //folding symbols removed

		vCardFileData = vCardFileData.replace(/\nEND:VCARD\n\n/g, "")
		vCardFileData = vCardFileData.replace(/\nEND:VCARD\n/g, "")
		vCardFileData = vCardFileData.replace(/\nEND:VCARD/g, "")
		vCardFileData = vCardFileData.substring(vCardFileData.indexOf(B) + B.length)
		return vCardFileData.split(B)
	} else {
		return null
	}
}

export function vCardEscapingSplit(details: string): string[] {
	details = details.replace(/\\\\/g, "--bslashbslash++")
	details = details.replace(/\\;/g, "--semiColonsemiColon++")
	details = details.replace(/\\:/g, "--dPunktdPunkt++")
	let array = details.split(";")
	array = array.map((elem) => {
		return elem.trim()
	})
	return array
}

export function vCardReescapingArray(details: string[]): string[] {
	return details.map((a) => {
		a = a.replace(/\-\-bslashbslash\+\+/g, "\\")
		a = a.replace(/\-\-semiColonsemiColon\+\+/g, ";")
		a = a.replace(/\-\-dPunktdPunkt\+\+/g, ":")
		a = a.replace(/\\n/g, "\n")
		a = a.replace(/\\,/g, ",")
		return a
	})
}

export function vCardEscapingSplitAdr(addressDetails: string): string[] {
	addressDetails = addressDetails.replace(/\\\\/g, "--bslashbslash++")
	addressDetails = addressDetails.replace(/\\;/g, "--semiColonsemiColon++")
	let array = addressDetails.split(";")
	return array.map((elem) => {
		if (elem.trim().length > 0) {
			return elem.trim().concat("\n")
		} else {
			// needed for only Space elements in Address
			return ""
		}
	})
}

function _decodeTag(encoding: string, charset: string, text: string): string {
	let decoder = (cs: string, l: string) => l

	switch (encoding.toLowerCase()) {
		case "quoted-printable:":
			decoder = decodeQuotedPrintable
			break

		case "base64:":
			decoder = decodeBase64
	}

	return text
		.split(";")
		.map((line) => decoder(charset, line))
		.join(";")
}

/**
 * @returns The list of created Contact instances (but not yet saved) or null if vCardFileData is not a valid vCard string.
 */
export function vCardListToContacts(vCardList: string[], ownerGroupId: Id): Contact[] {
	let contacts: Contact[] = []

	for (let i = 0; i < vCardList.length; i++) {
		let lastName: string = ""
		let firstName: string = ""
		let title: string | null = null
		let birthdayIso: string | null = null
		let company: string = ""
		let comment: string = ""
		let nickname: string | null = null
		let role = ""
		const addresses: Array<ContactAddress> = []
		const mailAddresses: Array<ContactMailAddress> = []
		const phoneNumbers: Array<ContactPhoneNumber> = []
		const socialIds: Array<ContactSocialId> = []
		let vCardLines = vCardList[i].split("\n")

		for (let j = 0; j < vCardLines.length; j++) {
			let indexAfterTag = vCardLines[j].indexOf(":")
			let tagAndTypeString = vCardLines[j].substring(0, indexAfterTag).toUpperCase()
			let tagName = tagAndTypeString.split(";")[0]
			let tagValue = vCardLines[j].substring(indexAfterTag + 1)
			let encodingObj = vCardLines[j].split(";").find((line) => line.includes("ENCODING="))
			let encoding = encodingObj ? encodingObj.split("=")[1] : ""
			let charsetObj = vCardLines[j].split(";").find((line) => line.includes("CHARSET="))
			let charset = charsetObj ? charsetObj.split("=")[1] : "utf-8"
			tagValue = _decodeTag(encoding, charset, tagValue)

			switch (tagName) {
				case "N":
					let nameDetails = vCardReescapingArray(vCardEscapingSplit(tagValue))

					for (let i = nameDetails.length; nameDetails.length < 3; i++) {
						nameDetails.push("")
					}

					lastName = nameDetails[0]
					firstName = (nameDetails[1] + " " + nameDetails[2]).trim() // nameDetails[2] (second first name) may be empty

					title = nameDetails[3]
					break

				case "FN":
					//Thunderbird can export FULLNAME tag if that is given with the email address automatic contact creation. If there is no first name or second name the namestring will be saved as full name.
					if (firstName === "" && lastName === "" && title == null) {
						let fullName = vCardReescapingArray(vCardEscapingSplit(tagValue))
						firstName = fullName.join(" ").replace(/"/g, "") //Thunderbird saves the Fullname in "quoteations marks" they are deleted here
					}

					break

				case "BDAY":
					let indexOfT = tagValue.indexOf("T")
					let bDayDetails: Birthday | null = null

					if (tagValue.match(/--\d{4}/g)) {
						bDayDetails = createBirthday({
							month: tagValue.substring(2, 4),
							day: tagValue.substring(4, 6),
							year: null,
						})
					} else if (tagValue.match(/\d{4}-\d{2}-\d{2}/g)) {
						let bDay = tagValue.substring(0, indexOfT !== -1 ? indexOfT : tagValue.length).split("-")
						bDayDetails = createBirthday({
							year: bDay[0].trim(),
							month: bDay[1].trim(),
							day: bDay[2].trim(),
						})
					} else if (tagValue.match(/\d{8}/g)) {
						bDayDetails = createBirthday({
							year: tagValue.substring(0, 4),
							month: tagValue.substring(4, 6),
							day: tagValue.substring(6, 8),
						})
					}

					if (bDayDetails && bDayDetails.year === "1111") {
						// we use 1111 as marker if no year has been defined as vcard 3.0 does not support dates without year
						bDayDetails.year = null
					}

					try {
						birthdayIso = bDayDetails && isValidBirthday(bDayDetails) ? birthdayToIsoDate(bDayDetails) : null
					} catch (e) {
						if (e instanceof ParsingError) {
							console.log("failed to parse birthday", e)
						} else {
							throw e
						}
					}

					break

				case "ORG":
					let orgDetails = vCardReescapingArray(vCardEscapingSplit(tagValue))
					company = orgDetails.join(" ")
					break

				case "NOTE":
					let note = vCardReescapingArray(vCardEscapingSplit(tagValue))
					comment = note.join(" ")
					break

				case "ADR":
				case "ITEM1.ADR": // necessary for apple vcards

				case "ITEM2.ADR":
					// necessary for apple vcards
					if (tagAndTypeString.indexOf("HOME") > -1) {
						_addAddress(tagValue, addresses, ContactAddressType.PRIVATE)
					} else if (tagAndTypeString.indexOf("WORK") > -1) {
						_addAddress(tagValue, addresses, ContactAddressType.WORK)
					} else {
						_addAddress(tagValue, addresses, ContactAddressType.OTHER)
					}

					break

				case "EMAIL":
				case "ITEM1.EMAIL": // necessary for apple and protonmail vcards

				case "ITEM2.EMAIL":
					// necessary for apple vcards
					if (tagAndTypeString.indexOf("HOME") > -1) {
						_addMailAddress(tagValue, mailAddresses, ContactAddressType.PRIVATE)
					} else if (tagAndTypeString.indexOf("WORK") > -1) {
						_addMailAddress(tagValue, mailAddresses, ContactAddressType.WORK)
					} else {
						_addMailAddress(tagValue, mailAddresses, ContactAddressType.OTHER)
					}

					break

				case "TEL":
				case "ITEM1.TEL": // necessary for apple vcards

				case "ITEM2.TEL":
					// necessary for apple vcards
					tagValue = tagValue.replace(/[\u2000-\u206F]/g, "")

					if (tagAndTypeString.indexOf("HOME") > -1) {
						_addPhoneNumber(tagValue, phoneNumbers, ContactPhoneNumberType.PRIVATE)
					} else if (tagAndTypeString.indexOf("WORK") > -1) {
						_addPhoneNumber(tagValue, phoneNumbers, ContactPhoneNumberType.WORK)
					} else if (tagAndTypeString.indexOf("FAX") > -1) {
						_addPhoneNumber(tagValue, phoneNumbers, ContactPhoneNumberType.FAX)
					} else if (tagAndTypeString.indexOf("CELL") > -1) {
						_addPhoneNumber(tagValue, phoneNumbers, ContactPhoneNumberType.MOBILE)
					} else {
						_addPhoneNumber(tagValue, phoneNumbers, ContactPhoneNumberType.OTHER)
					}

					break

				case "URL":
				case "ITEM1.URL": // necessary for apple vcards

				case "ITEM2.URL":
					// necessary for apple vcards
					let website = createContactSocialId({
						type: ContactSocialType.OTHER,
						socialId: vCardReescapingArray(vCardEscapingSplit(tagValue)).join(""),
						customTypeName: "",
					})
					socialIds.push(website)
					break

				case "NICKNAME":
					let nick = vCardReescapingArray(vCardEscapingSplit(tagValue))
					nickname = nick.join(" ")
					break

				case "PHOTO":
					// if (indexAfterTag < tagValue.indexOf(":")) {
					// 	indexAfterTag = tagValue.indexOf(":")
					// }
					// /*Here will be the photo import*/
					break

				case "ROLE":
				case "TITLE":
					let vcardRole = vCardReescapingArray(vCardEscapingSplit(tagValue))
					role += (" " + vcardRole.join(" ")).trim()
					break

				default:
			}
		}
		contacts[i] = createContact({
			_area: "0", // legacy
			_owner: ownerGroupId, // legacy
			autoTransmitPassword: "",
			_ownerGroup: ownerGroupId,
			lastName,
			firstName,
			title,
			birthdayIso,
			company,
			comment,
			nickname,
			role,
			addresses,
			mailAddresses,
			phoneNumbers,
			socialIds,
			presharedPassword: null,
			photo: null,
			oldBirthdayDate: null,
			oldBirthdayAggregate: null,
		})
	}

	function _addAddress(vCardAddressValue: string, addresses: Array<ContactAddress>, type: ContactAddressType) {
		let addressDetails = vCardReescapingArray(vCardEscapingSplitAdr(vCardAddressValue))
		let address = createContactAddress({
			type: type,
			address: addressDetails.join("").trim(),
			customTypeName: "",
		})
		addresses.push(address)
	}

	function _addPhoneNumber(vCardPhoneNumberValue: string, phoneNumbers: Array<ContactPhoneNumber>, type: ContactPhoneNumberType) {
		let phoneNumber = createContactPhoneNumber({
			type: type,
			number: vCardPhoneNumberValue,
			customTypeName: "",
		})
		phoneNumbers.push(phoneNumber)
	}

	function _addMailAddress(vCardMailAddressValue: string, mailAddresses: Array<ContactMailAddress>, type: ContactAddressType) {
		let email = createContactMailAddress({
			type: type,
			address: vCardMailAddressValue,
			customTypeName: "",
		})
		mailAddresses.push(email)
	}

	return contacts
}
